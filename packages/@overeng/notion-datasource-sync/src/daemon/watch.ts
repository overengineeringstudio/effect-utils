import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Duration, Effect, Schema } from 'effect'

import type { QueryContract } from '../core/commands.ts'
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
import type { OneShotSyncStatus } from '../core/status.ts'
import {
  shortSpanId,
  spanAttr,
  spanAttributes,
  spanLabel,
  spanNames,
  statusSpanAttributes,
} from '../observability/observability.ts'
import type { NotionSyncStore } from '../store/store.ts'
import type { SchemaPropertyObservation } from '../sync/observation.ts'
import { syncOneShot, type OneShotSyncResult } from '../sync/sync.ts'

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

/**
 * Runtime configuration for `runWatchDaemon` and `runWatchDaemonCycle`.
 *
 * Includes the sync dependencies (store, gateway ports, workspace root, contracts),
 * daemon identity / lease parameters, backoff mode, cycle cap, and optional
 * test-seam overrides for `sleep`, `now`, and the `AbortSignal`.
 */
export type WatchDaemonOptions = {
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
  readonly dataSourceId: DataSourceId
  readonly workspaceRoot: AbsolutePath
  readonly queryContract: QueryContract
  readonly schemaProperties: ReadonlyArray<SchemaPropertyObservation>
  readonly requiredCapabilities?: ReadonlyArray<CapabilityName>
  readonly materializeBodies?: boolean
  readonly statePath: string
  readonly mode?: WatchDaemonMode
  readonly maxCycles?: number
  readonly maxExecutorSteps?: number
  readonly leaseToken?: string
  readonly leaseDurationMs?: number
  readonly instanceId?: string
  readonly sleep?: (millis: number) => Effect.Effect<void>
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

const localStoreError = (operation: string, message: string, cause?: unknown) =>
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
      localStoreError(
        'watch-daemon-read-state',
        `Unable to read watch daemon state: ${input.statePath}`,
        cause,
      ),
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
      localStoreError(
        'watch-daemon-write-state',
        `Unable to write watch daemon state: ${input.statePath}`,
        cause,
      ),
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

const interruptOnAbort = <TValue, TError, TContext>(
  effect: Effect.Effect<TValue, TError, TContext>,
  input: {
    readonly signal: AbortSignal | undefined
    readonly rootId: SyncRootId
    readonly cycle: number
  },
): Effect.Effect<TValue, TError | WatchDaemonCancelled, TContext> =>
  input.signal === undefined
    ? effect
    : effect.pipe(Effect.raceFirst(abortSignalEffect({ ...input, signal: input.signal })))

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
    WatchDaemonCancelled | LocalStoreError | NotionGatewayError | BodySyncError | LocalStorageError,
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

      const sync = yield* interruptOnAbort(
        syncOneShot({
          store: options.store,
          rootId: options.rootId,
          dataSourceId: options.dataSourceId,
          workspaceRoot: options.workspaceRoot,
          queryContract: options.queryContract,
          schemaProperties: options.schemaProperties,
          ...(options.requiredCapabilities === undefined
            ? {}
            : { requiredCapabilities: options.requiredCapabilities }),
          ...(options.materializeBodies === undefined
            ? {}
            : { materializeBodies: options.materializeBodies }),
          maxExecutorSteps: options.maxExecutorSteps ?? 8,
          leaseToken:
            options.leaseToken ??
            defaultWatchDaemonLeaseToken({ rootId: options.rootId, instanceId }),
          leaseDurationMs: options.leaseDurationMs ?? 60_000,
          now,
        }),
        { signal: options.signal, rootId: options.rootId, cycle },
      ).pipe(
        Effect.tapError((cause) =>
          writeWatchDaemonState({
            statePath: options.statePath,
            state: {
              ...previous,
              cycle,
              lastStartedAt: startedAt,
              repair: {
                _tag: 'retry',
                reason:
                  typeof cause === 'object' && cause !== null && '_tag' in cause
                    ? String(cause._tag)
                    : 'unknown-daemon-cycle-error',
                retryAfterMillis: modeBackoffMillis(mode),
                failedCycle: cycle,
              },
            },
          }),
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
        repair: sync.status.state === 'clean' ? { _tag: 'none' } : previous.repair,
        lastStatus: sync.status,
      }
      yield* writeWatchDaemonState({ statePath: options.statePath, state })

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
          const delay =
            state.repair._tag === 'retry' ? state.repair.retryAfterMillis : modeBackoffMillis(mode)
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
          yield* sleep(delay)
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
