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
import {
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
import { pushOneShotSync, syncOneShot, type OneShotSyncResult } from '../sync/sync.ts'

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
  readonly storePath?: string
  readonly rootId: SyncRootId
  readonly dataSourceId: DataSourceId
  readonly workspaceRoot: AbsolutePath
  readonly queryContract: QueryContractType
  readonly schemaProperties?: ReadonlyArray<SchemaPropertyObservation>
  readonly requiredCapabilities?: ReadonlyArray<CapabilityName>
  readonly materializeBodies?: boolean
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
    cycle: Schema.Number,
    message: Schema.String,
  },
) {}

/** Tagged error raised when a daemon cycle exceeds its configured wall-clock budget. */
export class WatchDaemonCycleTimedOut extends Schema.TaggedError<WatchDaemonCycleTimedOut>()(
  'WatchDaemonCycleTimedOut',
  {
    rootId: Schema.String,
    cycle: Schema.Number,
    timeoutMillis: Schema.Number,
    message: Schema.String,
  },
) {}

const WatchDaemonStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  rootId: Schema.String,
  cycle: Schema.Number,
  lastCompleteCycle: Schema.Number,
  lastStartedAt: Schema.optional(Schema.String),
  lastCompletedAt: Schema.optional(Schema.String),
  repair: Schema.Union(
    Schema.TaggedStruct('none', {}),
    Schema.TaggedStruct('retry', {
      reason: Schema.String,
      retryAfterMillis: Schema.Number,
      failedCycle: Schema.Number,
    }),
  ),
  lastStatus: Schema.optional(Schema.Unknown),
}).annotations({ identifier: 'NotionDatasourceSync.WatchDaemonState' })

const decodeState = Schema.decodeUnknownSync(WatchDaemonStateSchema)
const decodeStateJson = Schema.decodeUnknownSync(Schema.parseJson(WatchDaemonStateSchema))

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

      return Effect.async<void>((resume, effectSignal) => {
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
      await writeFile(`${input.statePath}.tmp`, `${JSON.stringify(input.state, null, 2)}\n`, 'utf8')
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
  Effect.async<never, WatchDaemonCancelled>((resume, effectSignal) => {
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
            Effect.zipRight(
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
  const replicaPath = options.storePath
  if (
    replicaPath === undefined ||
    replicaPath === ':memory:' ||
    existsSync(replicaPath) === false
  ) {
    return { changes: [] as const, intents: [] as const, replicaPath }
  }
  const changes = readPendingReplicaChanges(replicaPath)
  applyReplicaConflictResolutions({
    changes,
    replicaPath,
    store: options.store,
    rootId: options.rootId,
  })
  const intents = replicaChangesToPlannerIntents({
    changes: changes.filter((change) => change.kind !== 'conflict_resolution'),
    replicaPath,
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
  projectReplicaFromSyncStore({
    syncStorePath: replicaPath,
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
 * Executes one full sync cycle under the `notion.datasource.daemon.pass` span.
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
      yield* Effect.annotateCurrentSpan(
        spanAttributes({
          [spanAttr.spanLabel]: spanLabel('cycle', cycle),
          [spanAttr.cycle]: cycle,
          [spanAttr.mode]: mode,
          [spanAttr.rootId]: options.rootId,
          [spanAttr.dataSourceId]: options.dataSourceId,
          [spanAttr.maxExecutorSteps]: options.maxExecutorSteps ?? 8,
          [spanAttr.leaseDurationMs]: options.leaseDurationMs ?? 60_000,
        }),
      )
      yield* ensureNotCancelled({ signal: options.signal, rootId: options.rootId, cycle })
      yield* reportSyncProgress({
        _tag: 'phase',
        phase: 'watching',
        message: `Starting watch cycle ${cycle.toString()}`,
      })

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

      const leaseToken =
        options.leaseToken ?? defaultWatchDaemonLeaseToken({ rootId: options.rootId, instanceId })
      const leaseDurationMs = options.leaseDurationMs ?? 60_000
      const claimedSignal = yield* Effect.sync(() =>
        options.store.claimNextSignal({
          rootId: options.rootId,
          leaseToken,
          leaseDurationMs,
        }),
      )
      const replicaInputs = yield* Effect.sync(() => readPendingReplicaPlannerInputs({ options }))
      const effectiveQueryContract = incrementalQueryContractForWatch({ options })
      const shouldRunFastPush =
        replicaInputs.intents.length > 0 || hasRunnableOutboxWork(options) === true
      const fastPush =
        shouldRunFastPush === true
          ? yield* pushOneShotSync({
              store: options.store,
              rootId: options.rootId,
              workspaceRoot: options.workspaceRoot,
              localIntents: replicaInputs.intents,
              materializeBodies: false,
              maxExecutorSteps: options.maxExecutorSteps ?? 8,
              leaseToken,
              leaseDurationMs,
              now,
            })
          : undefined
      if (fastPush !== undefined) {
        yield* Effect.sync(() => {
          if (replicaInputs.replicaPath === undefined || replicaInputs.replicaPath === ':memory:')
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
        localIntents: fastPush === undefined ? replicaInputs.intents : [],
        deferLocalPlanningUntilAfterPull: fastPush !== undefined,
        maxExecutorSteps: options.maxExecutorSteps ?? 8,
        leaseToken,
        leaseDurationMs,
        now,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (replicaInputs.replicaPath === undefined || replicaInputs.replicaPath === ':memory:')
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
            Effect.zipRight(
              writeWatchDaemonState({
                statePath: options.statePath,
                state: {
                  ...previous,
                  cycle,
                  lastStartedAt: startedAt,
                  repair: {
                    _tag: 'retry',
                    reason: daemonCycleErrorReason(cause),
                    retryAfterMillis: daemonCycleRetryAfterMillis(cause) ?? modeBackoffMillis(mode),
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
      yield* writeWatchDaemonState({ statePath: options.statePath, state })
      yield* reportSyncProgress({
        _tag: 'phase',
        phase: 'watching',
        message: `Completed watch cycle ${cycle.toString()}`,
      })

      yield* Effect.annotateCurrentSpan({
        ...statusSpanAttributes(sync.status),
        [spanAttr.result]: sync.status.state,
      })

      return {
        _tag: 'WatchDaemonCycleResult',
        rootId: options.rootId,
        cycle,
        status: sync.status,
        sync,
        state,
        signal: claimedSignal,
      }
    }),
)

/**
 * Runs the watch daemon loop under the `notion.datasource.daemon.run` span.
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
      yield* Effect.annotateCurrentSpan(
        spanAttributes({
          [spanAttr.spanLabel]: spanLabel('watch', shortSpanId(options.rootId)),
          [spanAttr.mode]: mode,
          [spanAttr.rootId]: options.rootId,
          [spanAttr.dataSourceId]: options.dataSourceId,
          [spanAttr.maxCycles]: maxCycles,
        }),
      )

      for (;;) {
        if (maxCycles !== undefined && attempted >= maxCycles) break

        attempted += 1
        const cycle = yield* runWatchDaemonCycle({ ...options, instanceId }).pipe(
          Effect.map((result) => ({ _tag: 'completed' as const, result })),
          Effect.catchTag('WatchDaemonCancelled', () =>
            Effect.succeed({ _tag: 'cancelled' as const }),
          ),
          Effect.catchAll(() => Effect.succeed({ _tag: 'retry' as const })),
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
          yield* Effect.annotateCurrentSpan(
            spanAttributes({
              [spanAttr.result]: 'cancelled',
              [spanAttr.cancelled]: true,
              [spanAttr.cycles]: result.cycles,
              [spanAttr.completedCycles]: result.completed,
              ...(result.lastStatus === undefined ? {} : statusSpanAttributes(result.lastStatus)),
            }),
          )
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
            yield* Effect.annotateCurrentSpan(
              spanAttributes({
                [spanAttr.result]: 'cancelled',
                [spanAttr.cancelled]: true,
                [spanAttr.cycles]: result.cycles,
                [spanAttr.completedCycles]: result.completed,
                ...(result.lastStatus === undefined ? {} : statusSpanAttributes(result.lastStatus)),
              }),
            )
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
      yield* Effect.annotateCurrentSpan(
        spanAttributes({
          [spanAttr.result]: 'completed',
          [spanAttr.cancelled]: false,
          [spanAttr.cycles]: result.cycles,
          [spanAttr.completedCycles]: result.completed,
          ...(result.lastStatus === undefined ? {} : statusSpanAttributes(result.lastStatus)),
        }),
      )
      return result
    }),
)
