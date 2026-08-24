import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Duration, Effect, Schema } from 'effect'

import type { QueryContract as QueryContractType } from '../core/commands.ts'
import type { AbsolutePath, CapabilityName, DataSourceId } from '../core/domain.ts'
import {
  LocalStoreError,
  type BodySyncError,
  type LocalStorageError,
  type NotionGatewayError,
} from '../core/errors.ts'
import type { SyncRootId } from '../core/events.ts'
import {
  type LocalWorkspacePort,
  type NotionDataSourceGateway,
  type PageBodySyncPort,
} from '../core/ports.ts'
import { reportSyncProgress } from '../core/progress.ts'
import type { SignalInboxRecord } from '../core/signals.ts'
import type { OneShotSyncStatus } from '../core/status.ts'
import type { AuthorityMode } from '../local/manifest.ts'
import {
  annotateSpan,
  shortSpanId,
  spanAttr,
  spanAttributes,
  spanLabel,
  spanNames,
  statusSpanAttributes,
} from '../observability/observability.ts'
import {
  applyReplicaConflictResolutions,
  projectReplicaFromSyncStore,
  readPendingReplicaChanges,
  replicaChangesToPlannerIntents,
  settleReplicaChangesAfterSync,
} from '../replica/replica.ts'
import type { NotionSyncStore } from '../store/store.ts'
import type { SchemaPropertyObservation } from '../sync/observation.ts'
import {
  pushOneShotSync,
  syncOneShot,
  type OneShotPushResult,
  type OneShotSyncResult,
} from '../sync/sync.ts'

/** Backoff tier for the watch daemon loop — controls the inter-cycle sleep duration (1 s / 5 s / 15 s). */
export type WatchDaemonMode = 'development' | 'normal' | 'low-priority'

/**
 * Persistent state written to disk after each daemon cycle.
 *
 * Tracks cycle counter, last-complete cycle, timestamps, and a `repair` tag that records
 * whether the previous cycle failed and how long to back off before retrying.
 */
export type WatchDaemonState = {
  readonly version: 1
  readonly rootId: SyncRootId
  readonly cycle: number
  readonly lastCompleteCycle: number
  readonly lastStartedAt: string | undefined
  readonly lastCompletedAt: string | undefined
  readonly repair:
    | { readonly _tag: 'none' }
    | {
        readonly _tag: 'retry'
        readonly reason: string
        readonly retryAfterMillis: number
        readonly failedCycle: number
      }
  readonly lastStatus: OneShotSyncStatus | undefined
}

/** Outcome of a single completed sync cycle, including the status snapshot, full sync result, and updated daemon state. */
export type WatchDaemonCycleResult = {
  readonly _tag: 'WatchDaemonCycleResult'
  readonly rootId: SyncRootId
  readonly cycle: number
  readonly status: OneShotSyncStatus
  readonly sync: OneShotSyncResult
  /**
   * Local-first fast-push pass (DAEMON-R07), present only when CDC/outbox work
   * triggered it. The fast-push CONSUMES the local intents, so `sync.push.plan`
   * is empty when this ran — the cycle's planned local outbound work lives HERE.
   * Surfacing it is essential for the `--dry-run` observe/plan/report frame: under
   * dry-run nothing is executed, so this plan is the only record of what WOULD be
   * done. (`runWatchDaemonCycle` always computed it; it was previously discarded.)
   */
  readonly fastPush: OneShotPushResult | undefined
  readonly state: WatchDaemonState
  readonly signal: SignalInboxRecord | undefined
}

/** Aggregate result for a full `runWatchDaemon` invocation: total attempted/completed cycles, cancellation flag, and final daemon state. */
export type WatchDaemonRunResult = {
  readonly _tag: 'WatchDaemonRunResult'
  readonly rootId: SyncRootId
  readonly cycles: number
  readonly completed: number
  readonly cancelled: boolean
  readonly lastStatus: OneShotSyncStatus | undefined
  readonly state: WatchDaemonState
}

/** In-process wake channel shared by webhook receivers and the watch daemon loop. */
export type WatchDaemonWakeNotifier = {
  readonly wake: () => void
  readonly awaitWake: (millis: number) => Effect.Effect<void>
}

/**
 * Runtime configuration for `runWatchDaemon` and `runWatchDaemonCycle`.
 *
 * Includes the sync dependencies (store, gateway ports, workspace root, contracts),
 * daemon identity / lease parameters, backoff mode, cycle cap, and optional
 * overrides for sleep, webhook wake notifications, now, and the AbortSignal.
 */
export type WatchDaemonOptions = {
  readonly store: NotionSyncStore
  /** Control-plane sync store path (`.notion/v1/state.sqlite` for a tracked workspace). */
  readonly storePath?: string
  /**
   * Public projection / CDC data file. Distinct from `storePath` for a tracked
   * workspace (control-plane split, decision 0020); equal to it for a standalone file.
   */
  readonly replicaPath?: string
  readonly rootId: SyncRootId
  readonly dataSourceId: DataSourceId
  readonly workspaceRoot: AbsolutePath
  readonly queryContract: QueryContractType
  readonly schemaProperties?: ReadonlyArray<SchemaPropertyObservation>
  readonly requiredCapabilities?: ReadonlyArray<CapabilityName>
  readonly materializeBodies?: boolean
  /** Workspace-wide authority mode threaded into the planner's `writeMode` (decisions 0015, 0019). */
  readonly authorityMode?: AuthorityMode
  /**
   * When `true`, run the cycle as an observe/plan/report loop with ZERO durable
   * effects (SM5.3 / CLI-R02 watch dry-run). Every loop-level write boundary is
   * suppressed: signal claim/settle/release (so a real running daemon's leased
   * signals are never fenced — observer non-interference), the daemon state file
   * (`statePath`), the replica settle/project write-back, the CDC `markChange` +
   * `ConflictRaised` writes in `readPendingReplicaPlannerInputs`, and the inner
   * pass writes (via `dryRun` threaded into `syncOneShot`/`pushOneShotSync`,
   * which carries the proven SM5.2 one-shot suppression — executor gate,
   * `materializeBodies:false`, append/replica guards). Real reads (Notion poll,
   * `.nmd`/SQLite scan, planning) still run so each cycle reports a plan frame.
   */
  readonly dryRun?: boolean
  readonly statePath: string
  readonly mode?: WatchDaemonMode
  readonly maxCycles?: number
  readonly maxExecutorSteps?: number
  readonly cycleTimeoutMs?: number
  readonly leaseToken?: string
  readonly leaseDurationMs?: number
  readonly instanceId?: string
  readonly sleep?: (millis: number) => Effect.Effect<void>
  readonly wakeNotifier?: WatchDaemonWakeNotifier
  readonly now?: () => Date
  readonly signal?: AbortSignal
}

/** Tagged error raised when an `AbortSignal` fires mid-cycle, allowing the daemon loop to exit cleanly. */
export class WatchDaemonCancelled extends Schema.TaggedError<WatchDaemonCancelled>()(
  'WatchDaemonCancelled',
  {
    rootId: Schema.String,
    cycle: Schema.Finite,
    message: Schema.String,
  },
) {}

/** Tagged error raised when a daemon cycle exceeds its configured wall-clock budget. */
export class WatchDaemonCycleTimedOut extends Schema.TaggedError<WatchDaemonCycleTimedOut>()(
  'WatchDaemonCycleTimedOut',
  {
    rootId: Schema.String,
    cycle: Schema.Finite,
    timeoutMillis: Schema.Finite,
    message: Schema.String,
  },
) {}

const WatchDaemonStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  rootId: Schema.String,
  cycle: Schema.Finite,
  lastCompleteCycle: Schema.Finite,
  lastStartedAt: Schema.optional(Schema.String),
  lastCompletedAt: Schema.optional(Schema.String),
  repair: Schema.Union([
    Schema.TaggedStruct('none', {}),
    Schema.TaggedStruct('retry', {
      reason: Schema.String,
      retryAfterMillis: Schema.Finite,
      failedCycle: Schema.Finite,
    }),
  ]),
  lastStatus: Schema.optional(Schema.Unknown),
}).annotate({ identifier: 'NotionDatasourceSync.WatchDaemonState' })

const decodeState = Schema.decodeUnknownSync(WatchDaemonStateSchema)
const decodeStateJson = Schema.decodeUnknownSync(Schema.fromJsonString(WatchDaemonStateSchema))
const encodeStateJson = Schema.encodeSync(
  Schema.fromJsonString(WatchDaemonStateSchema, { space: 2 }),
)

const modeBackoffMillis = (mode: WatchDaemonMode): number => {
  switch (mode) {
    case 'development':
      return 1_000
    case 'normal':
      return 5_000
    case 'low-priority':
      return 15_000
  }
}

/** Creates a process-local wake notifier. A receiver should enqueue a durable signal, then call `wake()`. */
export const makeWatchDaemonWakeNotifier = (): WatchDaemonWakeNotifier => {
  const waiters = new Set<() => void>()
  let pendingWake = false

  return {
    wake: () => {
      if (waiters.size === 0) {
        pendingWake = true
        return
      }

      pendingWake = false
      const callbacks = Array.from(waiters)
      waiters.clear()
      for (const callback of callbacks) {
        callback()
      }
    },
    awaitWake: (millis) => {
      if (millis <= 0 || pendingWake === true) {
        pendingWake = false
        return Effect.void
      }

      return Effect.callback<void>((resume, effectSignal) => {
        let completed = false
        let timeout: ReturnType<typeof setTimeout> | undefined
        const complete = () => {
          if (completed === true) return
          completed = true
          if (timeout !== undefined) {
            clearTimeout(timeout)
          }
          waiters.delete(complete)
          resume(Effect.void)
        }
        timeout = setTimeout(complete, millis)

        waiters.add(complete)
        effectSignal.addEventListener(
          'abort',
          () => {
            if (completed === true) return
            completed = true
            if (timeout !== undefined) {
              clearTimeout(timeout)
            }
            waiters.delete(complete)
          },
          { once: true },
        )
      })
    },
  }
}

/** Generates a fresh random UUID to identify one daemon process instance across its lifecycle. */
export const makeWatchDaemonInstanceId = (): string => randomUUID()

/** Derives the default event-log lease token for a daemon instance, encoding root and instance identity. */
export const defaultWatchDaemonLeaseToken = ({
  rootId,
  instanceId,
}: {
  readonly rootId: SyncRootId
  readonly instanceId: string
}): string => `watch:${rootId}:${instanceId}`

const initialState = (rootId: SyncRootId): WatchDaemonState =>
  decodeState({
    version: 1,
    rootId,
    cycle: 0,
    lastCompleteCycle: 0,
    repair: { _tag: 'none' },
  }) as WatchDaemonState

const localStoreError = ({
  operation,
  message,
  cause,
}: {
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}) =>
  new LocalStoreError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

/**
 * Reads and deserializes the daemon state JSON file from `statePath`.
 *
 * Returns the stored state if the `rootId` matches; returns a fresh initial state if the file
 * is missing or belongs to a different root. Fails with `LocalStoreError` on I/O or parse errors.
 */
export const readWatchDaemonState = (input: {
  readonly rootId: SyncRootId
  readonly statePath: string
}): Effect.Effect<WatchDaemonState, LocalStoreError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const parsed = decodeStateJson(await readFile(input.statePath, 'utf8')) as WatchDaemonState
        return parsed.rootId === input.rootId ? parsed : initialState(input.rootId)
      } catch (cause) {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'ENOENT'
        ) {
          return initialState(input.rootId)
        }
        throw cause
      }
    },
    catch: (cause) =>
      localStoreError({
        operation: 'watch-daemon-read-state',
        message: `Unable to read watch daemon state: ${input.statePath}`,
        cause,
      }),
  })

/** Atomically writes the daemon state to `statePath` via a `.tmp` rename, failing with `LocalStoreError` on I/O errors. */
export const writeWatchDaemonState = (input: {
  readonly statePath: string
  readonly state: WatchDaemonState
}): Effect.Effect<void, LocalStoreError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(input.statePath), { recursive: true })
      await writeFile(`${input.statePath}.tmp`, `${encodeStateJson(input.state)}\n`, 'utf8')
      await rename(`${input.statePath}.tmp`, input.statePath)
    },
    catch: (cause) =>
      localStoreError({
        operation: 'watch-daemon-write-state',
        message: `Unable to write watch daemon state: ${input.statePath}`,
        cause,
      }),
  })

const ensureNotCancelled = ({
  signal,
  rootId,
  cycle,
}: {
  readonly signal: AbortSignal | undefined
  readonly rootId: SyncRootId
  readonly cycle: number
}) =>
  signal?.aborted === true
    ? Effect.fail(
        new WatchDaemonCancelled({
          rootId,
          cycle,
          message: 'Watch daemon cycle was cancelled before it completed',
        }),
      )
    : Effect.void

const abortSignalEffect = ({
  signal,
  rootId,
  cycle,
}: {
  readonly signal: AbortSignal
  readonly rootId: SyncRootId
  readonly cycle: number
}): Effect.Effect<never, WatchDaemonCancelled> =>
  Effect.callback<never, WatchDaemonCancelled>((resume, effectSignal) => {
    const cancel = () =>
      resume(
        Effect.fail(
          new WatchDaemonCancelled({
            rootId,
            cycle,
            message: 'Watch daemon cycle was cancelled before it completed',
          }),
        ),
      )

    if (signal.aborted === true) {
      cancel()
      return
    }

    signal.addEventListener('abort', cancel, { once: true })
    effectSignal.addEventListener('abort', () => signal.removeEventListener('abort', cancel), {
      once: true,
    })
  })

const interruptOnAbort = <TValue, TError, TContext>({
  effect,
  signal,
  rootId,
  cycle,
}: {
  readonly effect: Effect.Effect<TValue, TError, TContext>
  readonly signal: AbortSignal | undefined
  readonly rootId: SyncRootId
  readonly cycle: number
}): Effect.Effect<TValue, TError | WatchDaemonCancelled, TContext> =>
  signal === undefined
    ? effect
    : effect.pipe(Effect.raceFirst(abortSignalEffect({ signal, rootId, cycle })))

const interruptOnTimeout = <TValue, TError, TContext>({
  effect,
  timeoutMs,
  rootId,
  cycle,
}: {
  readonly effect: Effect.Effect<TValue, TError, TContext>
  readonly timeoutMs: number | undefined
  readonly rootId: SyncRootId
  readonly cycle: number
}): Effect.Effect<TValue, TError | WatchDaemonCycleTimedOut, TContext> =>
  timeoutMs === undefined
    ? effect
    : effect.pipe(
        Effect.raceFirst(
          Effect.sleep(Duration.millis(timeoutMs)).pipe(
            Effect.andThen(
              Effect.fail(
                new WatchDaemonCycleTimedOut({
                  rootId,
                  cycle,
                  timeoutMillis: timeoutMs,
                  message: `Watch daemon cycle ${cycle.toString()} timed out after ${timeoutMs.toString()}ms`,
                }),
              ),
            ),
          ),
        ),
      )

const readPendingReplicaPlannerInputs = ({ options }: { readonly options: WatchDaemonOptions }) => {
  // CDC + planner intents target the public data file; the event log is the
  // control-plane store (`options.store`). decision 0020.
  const replicaPath = options.replicaPath ?? options.storePath
  if (
    replicaPath === undefined ||
    replicaPath === ':memory:' ||
    existsSync(replicaPath) === false
  ) {
    return { changes: [] as const, intents: [] as const, replicaPath }
  }
  const changes = readPendingReplicaChanges(replicaPath)
  // Under dry-run both helpers still READ and still RETURN intents (so the plan
  // frame is unaffected), but `dryRun` suppresses their durable writes:
  // `applyReplicaConflictResolutions` would append `ConflictRaised` events to the
  // event log, and `replicaChangesToPlannerIntents` would `markChange` the CDC
  // status in the data file on its reject/conflict-resolution paths. This mirrors
  // the one-shot `sync` path (main.ts), keeping the watch loop consistent with
  // the proven SM5.2 suppression guarantee.
  applyReplicaConflictResolutions({
    changes,
    replicaPath,
    store: options.store,
    rootId: options.rootId,
    ...(options.authorityMode === undefined ? {} : { authorityMode: options.authorityMode }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  })
  const intents = replicaChangesToPlannerIntents({
    changes: changes.filter((change) => change.kind !== 'conflict_resolution'),
    replicaPath,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  })
  return { changes, intents, replicaPath }
}

const projectReplicaIfWritable = ({
  options,
  replicaPath,
}: {
  readonly options: WatchDaemonOptions
  readonly replicaPath: string | undefined
}): void => {
  if (replicaPath === undefined || replicaPath === ':memory:') return
  // The control-plane store and the public projection may be distinct files
  // (decision 0020); project FROM the store INTO the data file. When they coincide
  // (standalone) this is the in-place unified projection.
  projectReplicaFromSyncStore({
    syncStorePath: options.storePath ?? replicaPath,
    replicaPath,
    rootId: options.rootId,
  })
}

const incrementalQueryContractForWatch = ({
  options,
}: {
  readonly options: WatchDaemonOptions
}): QueryContractType => {
  if (options.queryContract.highWatermark !== null) return options.queryContract
  const checkpoint = options.store.readLatestCompleteQueryCheckpoint({
    rootId: options.rootId,
    dataSourceId: options.dataSourceId,
  })
  if (checkpoint?.highWatermark === undefined || checkpoint.highWatermark === null) {
    return options.queryContract
  }
  return {
    ...options.queryContract,
    highWatermark: checkpoint.highWatermark,
  }
}

const hasRunnableOutboxWork = (options: WatchDaemonOptions): boolean =>
  options.store
    .readOutbox(options.rootId)
    .some(
      (command) =>
        command.state === 'queued' ||
        command.state === 'retryable' ||
        command.state === 'ambiguous',
    )

const daemonCycleErrorReason = (cause: unknown): string =>
  typeof cause === 'object' && cause !== null && '_tag' in cause
    ? String(cause._tag)
    : 'unknown-daemon-cycle-error'

const isNotionGatewayErrorWithRetryAfter = (
  cause: unknown,
): cause is NotionGatewayError & {
  retryAfterMillis: number
} =>
  typeof cause === 'object' &&
  cause !== null &&
  '_tag' in cause &&
  cause._tag === 'NotionGatewayError' &&
  typeof (cause as { retryAfterMillis?: number }).retryAfterMillis === 'number'

const daemonCycleRetryAfterMillis = (cause: unknown): number | undefined =>
  isNotionGatewayErrorWithRetryAfter(cause) === true ? cause.retryAfterMillis : undefined

/**
 * Executes one full sync cycle under the `notion_datasource.daemon.pass` span.
 *
 * Reads the previous daemon state, increments the cycle counter, runs `syncOneShot`,
 * and writes the updated state on both success and failure. Emits status span attributes
 * on completion. Propagates `WatchDaemonCancelled` if the `AbortSignal` fires mid-cycle.
 */
export const runWatchDaemonCycle = Effect.fn(spanNames.daemonPass, {
  attributes: spanAttributes({
    [spanAttr.spanLabel]: 'cycle',
    [spanAttr.processRole]: 'daemon',
    [spanAttr.operation]: 'cycle',
  }),
})(
  (
    options: WatchDaemonOptions,
  ): Effect.Effect<
    WatchDaemonCycleResult,
    | WatchDaemonCancelled
    | WatchDaemonCycleTimedOut
    | LocalStoreError
    | NotionGatewayError
    | BodySyncError
    | LocalStorageError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      const mode = options.mode ?? 'normal'
      const now = options.now ?? (() => new Date())
      const instanceId = options.instanceId ?? makeWatchDaemonInstanceId()
      const previous = yield* readWatchDaemonState({
        rootId: options.rootId,
        statePath: options.statePath,
      })
      const cycle = previous.cycle + 1
      const startedAt = now().toISOString()
      yield* annotateSpan({
        [spanAttr.spanLabel]: spanLabel('cycle', cycle),
        [spanAttr.cycle]: cycle,
        [spanAttr.mode]: mode,
        [spanAttr.rootId]: options.rootId,
        [spanAttr.dataSourceId]: options.dataSourceId,
        [spanAttr.maxExecutorSteps]: options.maxExecutorSteps ?? 8,
        [spanAttr.leaseDurationMs]: options.leaseDurationMs ?? 60_000,
      })
      yield* ensureNotCancelled({ signal: options.signal, rootId: options.rootId, cycle })
      yield* reportSyncProgress({
        _tag: 'phase',
        phase: 'watching',
        message: `Starting watch cycle ${cycle.toString()}`,
      })

      // Daemon state file: suppressed under dry-run (in-memory cycle accounting
      // only). The loop tracks attempted/completed cycles itself, so no on-disk
      // `statePath` write is needed to drive the observe/plan/report loop.
      if (options.dryRun !== true) {
        yield* writeWatchDaemonState({
          statePath: options.statePath,
          state: {
            ...previous,
            cycle,
            lastStartedAt: startedAt,
            repair:
              previous.lastCompleteCycle < previous.cycle
                ? {
                    _tag: 'retry',
                    reason: 'previous-cycle-did-not-complete',
                    retryAfterMillis: 0,
                    failedCycle: previous.cycle,
                  }
                : previous.repair,
          },
        })
      }

      const leaseToken =
        options.leaseToken ?? defaultWatchDaemonLeaseToken({ rootId: options.rootId, instanceId })
      const leaseDurationMs = options.leaseDurationMs ?? 60_000
      // Signal claim: under dry-run we must NOT claim/lease — claiming mutates the
      // signal row (state -> claimed, attempt_count += 1, lease_token) and would
      // fence a REAL running daemon's signals (observer non-interference). Keep
      // `claimedSignal` UNDEFINED so the downstream settle/release no-op
      // structurally, and read the next pending signal read-only purely to
      // populate the plan frame's `signal` field.
      const claimedSignal =
        options.dryRun === true
          ? undefined
          : yield* Effect.sync(() =>
              options.store.claimNextSignal({
                rootId: options.rootId,
                leaseToken,
                leaseDurationMs,
              }),
            )
      // Read-only view of the next pending signal the cycle would process,
      // reported in the plan frame's `signal` field. This APPROXIMATES the
      // next-claimable signal (sorted by `signalId`); exact parity with
      // `claimNextSignal`'s `ORDER BY updated_at, signal_id` is unnecessary
      // because a dry-run takes no signal action — the frame reports planned
      // work, not a committed claim order, and no signal row is mutated.
      const observedSignal =
        options.dryRun === true
          ? options.store
              .readSignals(options.rootId)
              .filter((signal) => signal.state === 'pending')
              .toSorted((left, right) => left.signalId.localeCompare(right.signalId))
              .at(0)
          : claimedSignal
      // Annotation-only: records how the cycle was triggered for observability.
      // Never gates which pages get read — fresh reads always run unconditionally.
      yield* annotateSpan({
        [spanAttr.wakeSource]:
          observedSignal === undefined
            ? 'poll'
            : observedSignal.provider === 'notion-webhook'
              ? 'webhook'
              : 'signal',
      })
      const replicaInputs = yield* Effect.sync(() => readPendingReplicaPlannerInputs({ options }))
      const effectiveQueryContract = incrementalQueryContractForWatch({ options })
      // SM5.4 / CLI-R07: the established workspace authority mode decides WHAT the
      // loop reconciles (orthogonal to `--watch-priority`, which decides how often).
      // A `remote` (mirror) workspace is pull-only: the remote→local pull pass always
      // runs, but the local-first PUSH passes are gated OFF entirely, so a pending
      // local edit surfaces as status/conflict and NEVER as a Notion write (no
      // outbound execution — the daemon's promise is to follow remote). `local` and
      // `shared` keep the full local-first push + remote pull cycle; their per-write
      // semantics are carried by the planner's `writeMode` overlay, not the loop.
      //
      // This is a deliberate, mode-scoped exception to DAEMON-R07's mandatory
      // local-first fast-push pass: DAEMON-R07 governs `local`/`shared`; `remote` is
      // mirror/pull-only. It is the loop-level complement to the planner's per-write
      // `RemoteAuthoritativeDrift` block (planner.ts) — together they make the
      // remote-mode "zero outbound write" guarantee structural rather than reliant on
      // every staged intent being individually refused.
      const isMirrorMode = options.authorityMode === 'remote'
      const shouldRunFastPush =
        isMirrorMode === false &&
        (replicaInputs.intents.length > 0 || hasRunnableOutboxWork(options) === true)
      const fastPush =
        shouldRunFastPush === true
          ? yield* pushOneShotSync({
              store: options.store,
              rootId: options.rootId,
              workspaceRoot: options.workspaceRoot,
              localIntents: replicaInputs.intents,
              materializeBodies: false,
              maxExecutorSteps: options.maxExecutorSteps ?? 8,
              ...(options.authorityMode === undefined
                ? {}
                : { authorityMode: options.authorityMode }),
              // Inner pass suppression (SM5.2): the executor gate, append guards,
              // and `materializeBodies:false` block all Notion/outbox/settlement/
              // event-log/body writes while still producing the plan.
              ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
              leaseToken,
              leaseDurationMs,
              now,
            })
          : undefined
      if (fastPush !== undefined) {
        yield* Effect.sync(() => {
          if (
            options.dryRun === true ||
            replicaInputs.replicaPath === undefined ||
            replicaInputs.replicaPath === ':memory:'
          )
            return
          settleReplicaChangesAfterSync({
            changes: replicaInputs.changes,
            replicaPath: replicaInputs.replicaPath,
            store: options.store,
            rootId: options.rootId,
            decisions: fastPush.plan.decisions,
          })
          projectReplicaIfWritable({ options, replicaPath: replicaInputs.replicaPath })
        })
      }
      const syncCycle = syncOneShot({
        store: options.store,
        rootId: options.rootId,
        dataSourceId: options.dataSourceId,
        workspaceRoot: options.workspaceRoot,
        queryContract: effectiveQueryContract,
        ...(options.schemaProperties === undefined
          ? {}
          : { schemaProperties: options.schemaProperties }),
        ...(options.requiredCapabilities === undefined
          ? {}
          : { requiredCapabilities: options.requiredCapabilities }),
        ...(options.materializeBodies === undefined
          ? {}
          : { materializeBodies: options.materializeBodies }),
        ...(options.authorityMode === undefined ? {} : { authorityMode: options.authorityMode }),
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        // Mirror mode runs the reconcile pull-only: no push pass, so the captured
        // local intents are deliberately not handed to the planner — they survive as
        // pending CDC/status and never become outbound work. `syncOneShot` already
        // gates pull-only on `authorityMode === 'remote'`, so the explicit
        // `pullOnly: true` and the empty `localIntents` are defense-in-depth that
        // also keep the daemon's intent explicit at the call site.
        ...(isMirrorMode === true ? { pullOnly: true } : {}),
        localIntents: isMirrorMode === true || fastPush !== undefined ? [] : replicaInputs.intents,
        deferLocalPlanningUntilAfterPull: fastPush !== undefined,
        maxExecutorSteps: options.maxExecutorSteps ?? 8,
        leaseToken,
        leaseDurationMs,
        now,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (
              options.dryRun === true ||
              replicaInputs.replicaPath === undefined ||
              replicaInputs.replicaPath === ':memory:'
            )
              return
            settleReplicaChangesAfterSync({
              changes: replicaInputs.changes,
              replicaPath: replicaInputs.replicaPath,
              store: options.store,
              rootId: options.rootId,
              decisions: result.push.plan.decisions,
            })
            projectReplicaIfWritable({ options, replicaPath: replicaInputs.replicaPath })
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            if (claimedSignal === undefined) return
            options.store.settleSignal({
              rootId: options.rootId,
              signalId: claimedSignal.signalId,
              leaseToken,
            })
          }),
        ),
      )
      const sync = yield* interruptOnTimeout({
        effect: interruptOnAbort({
          effect: syncCycle,
          signal: options.signal,
          rootId: options.rootId,
          cycle,
        }),
        timeoutMs: options.cycleTimeoutMs,
        rootId: options.rootId,
        cycle,
      }).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            if (claimedSignal === undefined) return
            options.store.releaseSignal({
              rootId: options.rootId,
              signalId: claimedSignal.signalId,
              leaseToken,
              error: daemonCycleErrorReason(cause),
            })
          }).pipe(
            // Failure-path state write is suppressed under dry-run too — a dry
            // run never persists `retry`/backoff bookkeeping.
            Effect.andThen(
              options.dryRun === true
                ? Effect.void
                : writeWatchDaemonState({
                    statePath: options.statePath,
                    state: {
                      ...previous,
                      cycle,
                      lastStartedAt: startedAt,
                      repair: {
                        _tag: 'retry',
                        reason: daemonCycleErrorReason(cause),
                        retryAfterMillis:
                          daemonCycleRetryAfterMillis(cause) ?? modeBackoffMillis(mode),
                        failedCycle: cycle,
                      },
                    },
                  }),
            ),
          ),
        ),
      )
      yield* ensureNotCancelled({ signal: options.signal, rootId: options.rootId, cycle })

      const state: WatchDaemonState = {
        version: 1,
        rootId: options.rootId,
        cycle,
        lastCompleteCycle: cycle,
        lastStartedAt: startedAt,
        lastCompletedAt: now().toISOString(),
        repair: { _tag: 'none' },
        lastStatus: sync.status,
      }
      // Completion-path state write: suppressed under dry-run. The returned
      // `state` value is still computed in-memory so the plan frame carries the
      // cycle's status, but it is never written to `statePath`.
      if (options.dryRun !== true) {
        yield* writeWatchDaemonState({ statePath: options.statePath, state })
      }
      yield* reportSyncProgress({
        _tag: 'phase',
        phase: 'watching',
        message: `Completed watch cycle ${cycle.toString()}`,
      })

      yield* annotateSpan({
        ...statusSpanAttributes(sync.status),
        [spanAttr.result]: sync.status.state,
      })

      return {
        _tag: 'WatchDaemonCycleResult',
        rootId: options.rootId,
        cycle,
        status: sync.status,
        sync,
        fastPush,
        state,
        // Under dry-run `claimedSignal` is undefined (no claim); report the
        // read-only `observedSignal` the cycle would have processed instead.
        signal: observedSignal,
      }
    }),
)

/**
 * Runs the watch daemon loop under the `notion_datasource.daemon.run` span.
 *
 * Repeatedly calls `runWatchDaemonCycle`, sleeping between cycles according to the
 * mode backoff or the `repair.retryAfterMillis` from the last failed cycle.
 * Stops when `maxCycles` is reached or the `AbortSignal` fires, returning a
 * `WatchDaemonRunResult` with aggregate cycle counts. Sync errors are swallowed
 * per-cycle and converted to a retry with backoff; only `LocalStoreError` writing
 * state can propagate out.
 */
export const runWatchDaemon = Effect.fn(spanNames.daemonRun, {
  attributes: spanAttributes({
    [spanAttr.spanLabel]: 'watch',
    [spanAttr.processRole]: 'daemon',
    [spanAttr.operation]: 'watch',
  }),
})(
  (
    options: WatchDaemonOptions,
  ): Effect.Effect<
    WatchDaemonRunResult,
    LocalStoreError | NotionGatewayError | BodySyncError | LocalStorageError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      const maxCycles = options.maxCycles
      const mode = options.mode ?? 'normal'
      const sleep = options.sleep ?? ((millis: number) => Effect.sleep(Duration.millis(millis)))
      const awaitWake = options.wakeNotifier?.awaitWake ?? sleep
      const instanceId = options.instanceId ?? makeWatchDaemonInstanceId()
      let completed = 0
      let attempted = 0
      let state = yield* readWatchDaemonState({
        rootId: options.rootId,
        statePath: options.statePath,
      })
      yield* annotateSpan({
        [spanAttr.spanLabel]: spanLabel('watch', shortSpanId(options.rootId)),
        [spanAttr.mode]: mode,
        [spanAttr.rootId]: options.rootId,
        [spanAttr.dataSourceId]: options.dataSourceId,
        [spanAttr.maxCycles]: maxCycles,
      })

      for (;;) {
        if (maxCycles !== undefined && attempted >= maxCycles) break

        attempted += 1
        const cycle = yield* runWatchDaemonCycle({ ...options, instanceId }).pipe(
          Effect.map((result) => ({ _tag: 'completed' as const, result })),
          Effect.catchTag('WatchDaemonCancelled', () =>
            Effect.succeed({ _tag: 'cancelled' as const }),
          ),
          Effect.orElseSucceed(() => ({ _tag: 'retry' as const })),
        )

        if (cycle._tag === 'cancelled') {
          const result = {
            _tag: 'WatchDaemonRunResult' as const,
            rootId: options.rootId,
            cycles: attempted,
            completed,
            cancelled: true,
            lastStatus: state.lastStatus,
            state,
          }
          yield* annotateSpan({
            [spanAttr.result]: 'cancelled',
            [spanAttr.cancelled]: true,
            [spanAttr.cycles]: result.cycles,
            [spanAttr.completedCycles]: result.completed,
            ...(result.lastStatus === undefined ? {} : statusSpanAttributes(result.lastStatus)),
          })
          return result
        }

        if (cycle._tag === 'completed') {
          completed += 1
          state = cycle.result.state
        } else {
          state = yield* readWatchDaemonState({
            rootId: options.rootId,
            statePath: options.statePath,
          })
        }

        if (maxCycles === undefined || attempted < maxCycles) {
          const pendingSignals = options.store.readSignalStatus(options.rootId).pending
          const delay =
            state.repair._tag === 'retry'
              ? state.repair.retryAfterMillis
              : pendingSignals > 0
                ? 0
                : modeBackoffMillis(mode)
          if (options.signal?.aborted === true) {
            const result = {
              _tag: 'WatchDaemonRunResult' as const,
              rootId: options.rootId,
              cycles: attempted,
              completed,
              cancelled: true,
              lastStatus: state.lastStatus,
              state,
            }
            yield* annotateSpan({
              [spanAttr.result]: 'cancelled',
              [spanAttr.cancelled]: true,
              [spanAttr.cycles]: result.cycles,
              [spanAttr.completedCycles]: result.completed,
              ...(result.lastStatus === undefined ? {} : statusSpanAttributes(result.lastStatus)),
            })
            return result
          }
          yield* awaitWake(delay)
        }
      }

      const result = {
        _tag: 'WatchDaemonRunResult' as const,
        rootId: options.rootId,
        cycles: attempted,
        completed,
        cancelled: false,
        lastStatus: state.lastStatus,
        state,
      }
      yield* annotateSpan({
        [spanAttr.result]: 'completed',
        [spanAttr.cancelled]: false,
        [spanAttr.cycles]: result.cycles,
        [spanAttr.completedCycles]: result.completed,
        ...(result.lastStatus === undefined ? {} : statusSpanAttributes(result.lastStatus)),
      })
      return result
    }),
)
