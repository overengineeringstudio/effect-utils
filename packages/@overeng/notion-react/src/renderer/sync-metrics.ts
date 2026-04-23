import type { SyncFallbackReason } from './render-to-notion.ts'
import { SyncEvent, type SyncEventHandler } from './sync-events.ts'

/**
 * Per-op-kind counter bag. `retrieve` accounts for the pre-flight
 * drift-probe GET + any nested retrieve-after-atomic-append calls.
 */
export interface OpCounts {
  readonly append: number
  readonly update: number
  readonly delete: number
  readonly retrieve: number
}

/**
 * Op Efficiency Ratio (actual / theoretical) per kind + aggregate total.
 * A perfectly efficient sync scores `total === 1` across the board; values
 * above 1 mean the driver issued more HTTP calls than the diff oracle said
 * the minimum was (e.g. atomic-container fan-out, coalescing miss).
 *
 * `retrieve` is special: the theoretical-minimum oracle has no retrieve
 * ops (the diff tally is pure mutation), so its theoretical count is 0.
 * We expose the retrieve actual count but fold it into the aggregate by
 * counting retrieves against an implicit theoretical of 0 → the total
 * OER includes retrieves on the *numerator* side only. Callers who need
 * a mutation-only OER should read `oer` excluding `retrieve`.
 */
export interface OerRatios {
  readonly append: number
  readonly update: number
  readonly delete: number
  readonly retrieve: number
  /**
   * Aggregate across all kinds. `actualTotal / theoreticalTotal`, where
   * `theoreticalTotal = appends + inserts + updates + removes` from the
   * diff plan (retrieves excluded from the denominator but counted in the
   * numerator — see the top-level note).
   */
  readonly total: number
}

/**
 * Snapshot of a single `sync()` invocation, derived purely from the
 * SyncEvent stream. Produced by {@link aggregateMetrics}; consumed by
 * the `onMetrics` callback on `sync()`.
 */
export interface SyncMetrics {
  readonly pageId: string
  readonly fallbackReason: SyncFallbackReason | null
  readonly durationMs: number
  /** What the diff algorithm said the minimum plan is. */
  readonly theoreticalMinOps: OpCounts
  /** What actually hit the network. */
  readonly actualOps: OpCounts
  readonly oer: OerRatios
  readonly cacheOutcome: 'hit' | 'miss' | 'drift' | 'page-id-drift' | null
  readonly updateNoopCount: number
  readonly batchCount: number
  /** Whether the sync completed without a `NotionSyncError` escape. */
  readonly ok: boolean
}

/**
 * Event handler + one-shot getter. Call the returned function for each
 * SyncEvent; read `getMetrics()` any time after `SyncEnd` to get the
 * consolidated snapshot. Before `SyncEnd` the metrics are a live view
 * of the in-progress sync (useful for structured logs / partial traces).
 */
export interface MetricsAggregator {
  readonly handler: SyncEventHandler
  readonly getMetrics: () => SyncMetrics
}

const zeroOps = (): { append: number; update: number; delete: number; retrieve: number } => ({
  append: 0,
  update: 0,
  delete: 0,
  retrieve: 0,
})

const safeRatio = (actual: number, theoretical: number): number => {
  if (theoretical === 0) return actual === 0 ? 1 : 0
  return actual / theoretical
}

export const aggregateMetrics = (): MetricsAggregator => {
  let pageId = ''
  let fallbackReason: SyncFallbackReason | null = null
  let cacheOutcome: SyncMetrics['cacheOutcome'] = null
  let durationMs = 0
  let ok = false
  let syncEnded = false
  let updateNoopCount = 0
  let batchCount = 0
  /* Theoretical = diff plan tally. Populated from `PlanComputed`. Note
     the diff plan's `inserts` fold into `append` in actualOps counting
     (both kinds go out as notion append HTTP calls), so we pre-sum them
     into `append` here too to keep the OER denominators apples-to-apples. */
  const theoretical = zeroOps()
  const actual = zeroOps()

  const handler: SyncEventHandler = (event) =>
    SyncEvent.$match(event, {
      SyncStart: (e) => {
        pageId = e.pageId
      },
      SyncEnd: (e) => {
        durationMs = e.durationMs
        ok = e.ok
        syncEnded = true
        if (e.fallbackReason !== undefined && fallbackReason === null) {
          fallbackReason = e.fallbackReason
        }
      },
      CacheOutcome: (e) => {
        cacheOutcome = e.kind
      },
      PlanComputed: (e) => {
        theoretical.append = e.appends + e.inserts
        theoretical.update = e.updates
        theoretical.delete = e.removes
      },
      OpIssued: (e) => {
        actual[e.kind] += 1
      },
      /* OpSucceeded / OpFailed carry no new counts; they correlate with
         OpIssued. We intentionally count OpIssued (not OpSucceeded) so a
         mid-sync failure still bills the HTTP call that was sent. */
      OpSucceeded: () => {},
      OpFailed: () => {},
      BatchFlush: () => {
        batchCount += 1
      },
      FallbackTriggered: (e) => {
        fallbackReason = e.reason
      },
      CheckpointWritten: () => {},
      UpdateNoop: () => {
        updateNoopCount += 1
      },
      UploadIdRejected: () => {},
      // Page-scope ops (#618 phase 3b) are counted separately on the sync
      // result; they do not fold into the block-op OER numerator/denominator.
      PageOpIssued: () => {},
      PageOpApplied: () => {},
    })

  const getMetrics = (): SyncMetrics => {
    const actualSnapshot: OpCounts = { ...actual }
    const theoreticalSnapshot: OpCounts = { ...theoretical }
    const theoreticalTotal =
      theoretical.append + theoretical.update + theoretical.delete + theoretical.retrieve
    const actualTotal = actual.append + actual.update + actual.delete + actual.retrieve
    return {
      pageId,
      fallbackReason,
      durationMs,
      theoreticalMinOps: theoreticalSnapshot,
      actualOps: actualSnapshot,
      oer: {
        append: safeRatio(actual.append, theoretical.append),
        update: safeRatio(actual.update, theoretical.update),
        delete: safeRatio(actual.delete, theoretical.delete),
        retrieve: safeRatio(actual.retrieve, theoretical.retrieve),
        total: safeRatio(actualTotal, theoreticalTotal),
      },
      cacheOutcome,
      updateNoopCount,
      batchCount,
      ok: ok && syncEnded,
    }
  }

  return { handler, getMetrics }
}
