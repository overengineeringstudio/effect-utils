import { Data } from 'effect'

import type { SyncFallbackReason } from './render-to-notion.ts'

/**
 * Observability events emitted by `sync()` when the caller passes an
 * `onEvent` hook. v1 surface: enough for consumers to measure HTTP op
 * volume, cache efficiency, batching efficiency, per-op latency, and
 * spurious updates.
 *
 * Design contract:
 *   - Emit sites are a single `if (onEvent !== undefined)` guarded call;
 *     no event construction (and no closure allocation) when unsubscribed.
 *   - `OpIssued.id` correlates to exactly one `OpSucceeded`/`OpFailed`
 *     with the same `id` (sync-local monotonic counter).
 *   - Keep `onEvent` fast: it runs synchronously in the sync driver's
 *     hot path. Buffer / enqueue if you need to do real work.
 */
export type SyncEvent = Data.TaggedEnum<{
  SyncStart: {
    readonly pageId: string
    readonly rootBlockCount: number
    readonly at: number
  }
  SyncEnd: {
    readonly pageId: string
    readonly durationMs: number
    readonly ok: boolean
    readonly opCount: number
    readonly fallbackReason?: SyncFallbackReason
    readonly at: number
  }
  CacheOutcome: {
    readonly kind: 'hit' | 'miss' | 'drift' | 'page-id-drift'
    readonly pageId: string
    readonly at: number
  }
  OpIssued: {
    readonly id: number
    readonly kind: 'append' | 'update' | 'delete' | 'retrieve'
    readonly at: number
  }
  OpSucceeded: {
    readonly id: number
    readonly kind: 'append' | 'update' | 'delete' | 'retrieve'
    readonly durationMs: number
    /** For `append`: number of children committed in this call. Otherwise 1. */
    readonly resultCount: number
    /**
     * Optional sub-classifier for the success. Today:
     *   - `'already-archived'` — `delete` op hit a block Notion had already
     *     archived / deleted. Treated as idempotent success: the desired end
     *     state ("gone") already holds. No cache mutation needed beyond the
     *     normal remove checkpoint.
     */
    readonly note?: 'already-archived'
    readonly at: number
  }
  OpFailed: {
    readonly id: number
    readonly kind: 'append' | 'update' | 'delete' | 'retrieve'
    readonly durationMs: number
    readonly error: string
    readonly at: number
  }
  BatchFlush: {
    /** Number of diff ops that mapped to this single HTTP call. */
    readonly issued: number
    /** Batch size committed (equals `issued` today; preserved for future coalescing). */
    readonly batched: number
    readonly at: number
  }
  FallbackTriggered: {
    readonly reason: SyncFallbackReason
    readonly at: number
  }
  CheckpointWritten: {
    readonly pageId: string
    readonly bytes?: number
    readonly at: number
  }
  UpdateNoop: {
    readonly id: number
    readonly blockId: string
    readonly reason: 'hash-equal' | 'other'
    readonly at: number
  }
  /**
   * Emitted once per sync, right after the diff plan is computed (and
   * before any HTTP ops are issued). Carries the *theoretical minimum*
   * op counts — i.e. what the diff algorithm decided is the smallest
   * cache→candidate reconciliation. The downstream op-folding /
   * batching / atomic-container rewriting may change the actual HTTP
   * request count, but this event fixes the oracle against which Op
   * Efficiency Ratio (OER) is measured.
   */
  PlanComputed: {
    readonly pageId: string
    readonly appends: number
    readonly inserts: number
    readonly updates: number
    readonly removes: number
    readonly at: number
  }
}>

export const SyncEvent = Data.taggedEnum<SyncEvent>()

export type SyncEventHandler = (event: SyncEvent) => void
