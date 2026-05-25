import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Effect, Schema } from 'effect'

import type { QueryContract } from './commands.ts'
import type { AbsolutePath, DataSourceId } from './domain.ts'
import {
  LocalStoreError,
  type BodySyncError,
  type LocalStorageError,
  type NotionGatewayError,
} from './errors.ts'
import type { SyncRootId } from './events.ts'
import type { SchemaPropertyObservation } from './observation.ts'
import {
  type LocalWorkspacePort,
  type NotionDataSourceGateway,
  type PageBodySyncPort,
} from './ports.ts'
import type { OneShotSyncStatus } from './status.ts'
import type { NotionSyncStore } from './store.ts'
import { syncOneShot, type OneShotSyncResult } from './sync.ts'

export type WatchDaemonMode = 'development' | 'normal' | 'low-priority'

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

export type WatchDaemonCycleResult = {
  readonly _tag: 'WatchDaemonCycleResult'
  readonly rootId: SyncRootId
  readonly cycle: number
  readonly status: OneShotSyncStatus
  readonly sync: OneShotSyncResult
  readonly state: WatchDaemonState
}

export type WatchDaemonRunResult = {
  readonly _tag: 'WatchDaemonRunResult'
  readonly rootId: SyncRootId
  readonly cycles: number
  readonly completed: number
  readonly cancelled: boolean
  readonly lastStatus: OneShotSyncStatus | undefined
  readonly state: WatchDaemonState
}

export type WatchDaemonOptions = {
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
  readonly dataSourceId: DataSourceId
  readonly workspaceRoot: AbsolutePath
  readonly queryContract: QueryContract
  readonly schemaProperties: ReadonlyArray<SchemaPropertyObservation>
  readonly statePath: string
  readonly mode?: WatchDaemonMode
  readonly maxCycles?: number
  readonly maxExecutorSteps?: number
  readonly leaseToken?: string
  readonly leaseDurationMs?: number
  readonly now?: () => Date
  readonly signal?: AbortSignal
}

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

export const runWatchDaemonCycle = Effect.fn(
  'NotionDatasourceSync.WatchDaemon.runWatchDaemonCycle',
)(
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
      const previous = yield* readWatchDaemonState({
        rootId: options.rootId,
        statePath: options.statePath,
      })
      const cycle = previous.cycle + 1
      const startedAt = now().toISOString()
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

      const sync = yield* syncOneShot({
        store: options.store,
        rootId: options.rootId,
        dataSourceId: options.dataSourceId,
        workspaceRoot: options.workspaceRoot,
        queryContract: options.queryContract,
        schemaProperties: options.schemaProperties,
        maxExecutorSteps: options.maxExecutorSteps ?? 8,
        leaseToken: options.leaseToken ?? `watch:${options.rootId}`,
        leaseDurationMs: options.leaseDurationMs ?? 60_000,
        now,
      }).pipe(
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

export const runWatchDaemon = Effect.fn('NotionDatasourceSync.WatchDaemon.runWatchDaemon')(
  (
    options: WatchDaemonOptions,
  ): Effect.Effect<
    WatchDaemonRunResult,
    LocalStoreError | NotionGatewayError | BodySyncError | LocalStorageError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      const maxCycles = options.maxCycles ?? 1
      let completed = 0
      let state = yield* readWatchDaemonState({
        rootId: options.rootId,
        statePath: options.statePath,
      })

      for (let index = 0; index < maxCycles; index += 1) {
        const cycle = yield* runWatchDaemonCycle(options).pipe(
          Effect.catchTag('WatchDaemonCancelled', () => Effect.succeed(undefined)),
        )
        if (cycle === undefined) {
          return {
            _tag: 'WatchDaemonRunResult',
            rootId: options.rootId,
            cycles: maxCycles,
            completed,
            cancelled: true,
            lastStatus: state.lastStatus,
            state,
          }
        }
        completed += 1
        state = cycle.state
      }

      return {
        _tag: 'WatchDaemonRunResult',
        rootId: options.rootId,
        cycles: maxCycles,
        completed,
        cancelled: false,
        lastStatus: state.lastStatus,
        state,
      }
    }),
)
