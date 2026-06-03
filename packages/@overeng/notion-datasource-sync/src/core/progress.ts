import { Context, Effect, Option, Schema } from 'effect'

/** Coarse operation phases emitted by sync code for CLI/TUI progress. */
export const SyncProgressPhase = Schema.Literal(
  'preparing',
  'pulling',
  'querying',
  'hydrating',
  'planning',
  'pushing',
  'executing',
  'projecting',
  'watching',
  'complete',
)

export type SyncProgressPhase = typeof SyncProgressPhase.Type

/** Progress events are additive hints; sync correctness must never depend on their delivery. */
export type SyncProgressEvent =
  | {
      readonly _tag: 'phase'
      readonly phase: SyncProgressPhase
      readonly message?: string
    }
  | {
      readonly _tag: 'query-page'
      readonly pages: number
      readonly rows: number
      readonly hasMore: boolean
    }
  | {
      readonly _tag: 'hydrate-row'
      readonly current: number
      readonly total: number
    }
  | {
      readonly _tag: 'executor-step'
      readonly current: number
      readonly max: number
      readonly result: string
    }
  | {
      readonly _tag: 'rate-limit'
      readonly operation: string
      readonly method: string
      readonly status: number
      readonly requestCount: number
      readonly remaining?: number
      readonly resetAfterSeconds?: number
      readonly retryDelayMs?: number
    }

/** Service contract for publishing best-effort sync progress events. */
export type SyncProgressReporter = {
  readonly report: (event: SyncProgressEvent) => Effect.Effect<void>
}

/** Optional Effect service used by CLI/TUI surfaces to observe sync progress. */
export class SyncProgress extends Context.Tag('@overeng/notion-datasource-sync/SyncProgress')<
  SyncProgress,
  SyncProgressReporter
>() {}

/** Emits a sync progress event when the optional progress service is available. */
export const reportSyncProgress = (event: SyncProgressEvent): Effect.Effect<void> =>
  Effect.serviceOption(SyncProgress).pipe(
    Effect.flatMap((service) =>
      Option.match(service, {
        onNone: () => Effect.void,
        onSome: (progress) => progress.report(event),
      }),
    ),
  )
