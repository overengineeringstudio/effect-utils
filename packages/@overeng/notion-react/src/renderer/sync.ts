import { Duration, Effect, Option, Schedule, Stream } from 'effect'
import type { ReactNode } from 'react'

import { NotionApiError } from '@overeng/notion-effect-client'

import type { CacheNode, CacheTree, NotionCache, PendingChild } from '../cache/types.ts'
import { CACHE_SCHEMA_VERSION } from '../cache/types.ts'
import {
  NotionBlocks,
  NotionPages,
  NotionRendererClientLive,
  type NotionRendererClient,
} from './client.ts'
import { NotionSyncError } from './errors.ts'
import type { PageOp } from './op-buffer.ts'
import { pageLifecycleViolations, type PageLifecycle } from './page-lifecycle.ts'
import {
  ATOMIC_CONTAINERS,
  emptyPageCounts,
  issueBlockUpdate,
  MAX_CHILDREN_PER_APPEND,
  type PageOpCounts,
  type SyncFallbackReason,
  type SyncResult,
} from './render-to-notion.ts'
import {
  buildCandidateTree,
  candidateToCache,
  diff,
  iconOrCoverDrift,
  tallyDiff,
  tallyPageOps,
  type CandidateNode,
  type CandidateTree,
  type DiffOp,
} from './sync-diff.ts'
import { SyncEvent, type SyncEventHandler } from './sync-events.ts'
import { aggregateMetrics, type SyncMetrics } from './sync-metrics.ts'
import {
  extractFileUploadId,
  isUploadIdRejection,
  replaceFileUploadId,
  type OnUploadIdRejected,
  type UploadIdRejectionContext,
} from './upload-id-retry.ts'

/**
 * Does this error indicate the target block is already in the desired
 * "gone" state? Matches Notion's archived-block validation_error and the
 * 404 object_not_found shape. Used to treat deletes as idempotent (dogfood
 * v5: a warm sync's drift-recovery emitted deletes against blocks that had
 * already been archived out of band, and the first 400 response aborted
 * the entire sync mid-batch).
 */
const isAlreadyGoneError = (err: unknown): boolean => {
  if (!(err instanceof NotionApiError)) return false
  if (err.code === 'object_not_found') return true
  if (err.code === 'validation_error' && /archived/i.test(err.message)) return true
  return false
}

/** Resolve every tmp-id reference in `tree` using the provided id map. */
const resolveTreeIds = (tree: CandidateTree, idMap: ReadonlyMap<string, string>): void => {
  const walk = (node: CandidateNode): void => {
    if (node.blockId !== undefined && idMap.has(node.blockId)) {
      node.blockId = idMap.get(node.blockId)!
    }
    for (const child of node.children) walk(child)
  }
  for (const c of tree.children) walk(c)
}

const appendBody = (type: string, props: Record<string, unknown>): Record<string, unknown> => ({
  object: 'block',
  type,
  [type]: props,
})

/**
 * Mutable working copy of the on-disk cache used for batch-level
 * checkpointing (#102). After each successful API call we mutate this
 * structure to reflect confirmed server state, then flush it to the
 * cache backend using the backend's atomic write path (tmp + rename for
 * `FsCache`).
 *
 * Invariant: every `WorkingNode` in the tree has a real server block id
 * (never a `tmp-*` placeholder). Ops only mutate the working copy *after*
 * their HTTP response resolves tmp ids to server ids.
 */
interface WorkingNode {
  readonly key: string
  readonly blockId: string
  type: string
  hash: string
  children: WorkingNode[]
  /**
   * Phase 3c (cache v3): distinguishes sub-pages from regular blocks inside
   * the working cache. Page nodes carry their own children bucket (reconciled
   * by recursive diffChildren under `scopePageId = this.blockId`) and
   * persist per-field metadata hashes so the outer cache round-trips them.
   */
  nodeKind: 'block' | 'page'
  titleHash?: string | undefined
  iconHash?: string | undefined
  coverHash?: string | undefined
  pendingChildren?: readonly PendingChild[] | undefined
}

interface WorkingCache {
  readonly rootId: string
  readonly rootChildren: WorkingNode[]
  /** blockId → node (or `undefined` sentinel for the root page itself). */
  readonly byId: Map<string, WorkingNode | undefined>
  /** parent-id → children array (lets ops target either root or a block). */
  readonly childrenById: Map<string, WorkingNode[]>
}

const cacheNodeToWorking = (n: CacheNode): WorkingNode => ({
  key: n.key,
  blockId: n.blockId,
  type: n.type,
  hash: n.hash,
  children: n.children.map(cacheNodeToWorking),
  nodeKind: n.nodeKind,
  ...(n.titleHash !== undefined ? { titleHash: n.titleHash } : {}),
  ...(n.iconHash !== undefined ? { iconHash: n.iconHash } : {}),
  ...(n.coverHash !== undefined ? { coverHash: n.coverHash } : {}),
  ...(n.pendingChildren !== undefined ? { pendingChildren: n.pendingChildren } : {}),
})

const workingToCacheNode = (n: WorkingNode): CacheNode => {
  // Defensive: `drift:*` synthetic keys are an in-memory artefact of
  // `driftedBase`. They must never escape to disk — a persisted ghost with
  // `type:'unknown'` / empty hash would drive a poisoned remove op on the
  // next sync (dogfood v4 failure mode). The fallback path initializes the
  // working cache empty for drifted syncs, so reaching this branch means a
  // regression in that wiring.
  if (n.key.startsWith('drift:') || (n.type === 'unknown' && n.hash === '')) {
    throw new Error(
      `notion-react: ghost entry leaked into working cache (key=${n.key}, blockId=${n.blockId}). ` +
        `Drift placeholders must not be checkpointed.`,
    )
  }
  return {
    key: n.key,
    blockId: n.blockId,
    type: n.type,
    hash: n.hash,
    children: n.children.map(workingToCacheNode),
    nodeKind: n.nodeKind,
    ...(n.titleHash !== undefined ? { titleHash: n.titleHash } : {}),
    ...(n.iconHash !== undefined ? { iconHash: n.iconHash } : {}),
    ...(n.coverHash !== undefined ? { coverHash: n.coverHash } : {}),
    ...(n.pendingChildren !== undefined ? { pendingChildren: n.pendingChildren } : {}),
  }
}

const initWorkingCache = (base: CacheTree): WorkingCache => {
  const rootChildren = base.children.map(cacheNodeToWorking)
  const byId = new Map<string, WorkingNode | undefined>()
  const childrenById = new Map<string, WorkingNode[]>()
  byId.set(base.rootId, undefined) // sentinel — root page has no node record
  childrenById.set(base.rootId, rootChildren)
  const index = (node: WorkingNode): void => {
    byId.set(node.blockId, node)
    childrenById.set(node.blockId, node.children)
    for (const c of node.children) index(c)
  }
  for (const c of rootChildren) index(c)
  return { rootId: base.rootId, rootChildren, byId, childrenById }
}

const workingToCacheTree = (w: WorkingCache): CacheTree => ({
  schemaVersion: CACHE_SCHEMA_VERSION,
  rootId: w.rootId,
  children: w.rootChildren.map(workingToCacheNode),
})

/**
 * Add a newly-created block under `parentId` at an optional position. New
 * blocks arrive without children (the sync driver emits descendant appends
 * as subsequent ops).
 */
const workingAppend = (
  w: WorkingCache,
  parentId: string,
  node: WorkingNode,
  afterId: string | undefined,
): void => {
  const siblings = w.childrenById.get(parentId)
  if (siblings === undefined) {
    // Parent not in working cache — this happens when appending under a
    // freshly-minted parent whose own creation batch has just landed.
    // Register an empty children bucket and retry.
    w.childrenById.set(parentId, [])
    workingAppend(w, parentId, node, afterId)
    return
  }
  // Atomic append acknowledgements are saved before their descendant GETs,
  // then refreshed with resolved child ids without moving the container.
  const existing = w.byId.get(node.blockId)
  const existingIndex = existing === undefined ? -1 : siblings.indexOf(existing)
  if (existing !== undefined) workingRemove(w, node.blockId)
  if (existingIndex >= 0) {
    siblings.splice(existingIndex, 0, node)
  } else if (afterId === '') {
    // Empty-string afterId is the head-insert marker threaded through from
    // the diff (sync-diff.ts `prevRef = ''`). Must prepend, not tail-append.
    siblings.unshift(node)
  } else if (afterId === undefined) {
    siblings.push(node)
  } else {
    const idx = siblings.findIndex((s) => s.blockId === afterId)
    if (idx >= 0) siblings.splice(idx + 1, 0, node)
    else siblings.push(node)
  }
  // Recursively register `node` and any descendants it carries into the
  // working-cache indexes. The descendant case only fires for atomic
  // containers (column_list / table) whose children were absorbed into the
  // create request — without this, mid-sync checkpoints would write the
  // container with an empty `children` bucket even though the server holds
  // the full subtree, and a subsequent warm sync would re-emit the entire
  // subtree (pixeltrail dogfood v8: cache inflated 609 → 710 after one warm
  // sync that rebuilt a column_list).
  const register = (n: WorkingNode): void => {
    w.byId.set(n.blockId, n)
    if (!w.childrenById.has(n.blockId)) w.childrenById.set(n.blockId, n.children)
    for (const c of n.children) register(c)
  }
  register(node)
}

const workingUpdate = (w: WorkingCache, blockId: string, type: string, hash: string): void => {
  const node = w.byId.get(blockId)
  if (node === undefined) return
  node.type = type
  node.hash = hash
}

const workingRemove = (w: WorkingCache, blockId: string): void => {
  const node = w.byId.get(blockId)
  if (node === undefined) return
  // Detach from parent by walking every bucket; fast path rare — most
  // syncs have small remove counts.
  for (const bucket of w.childrenById.values()) {
    const idx = bucket.indexOf(node)
    if (idx >= 0) {
      bucket.splice(idx, 1)
      break
    }
  }
  const drop = (n: WorkingNode): void => {
    w.byId.delete(n.blockId)
    w.childrenById.delete(n.blockId)
    for (const c of n.children) drop(c)
  }
  drop(node)
}

/**
 * Notion's `append children` endpoint caps each request at 100 children.
 * Consecutive appends/inserts sharing a parent are coalesced into batched
 * API calls bounded by this limit.
 *
 * The same 100-cap applies to any nested `children` array inside a create
 * body (e.g. a `table` block shipped with rows inlined as
 * `table.children`). See `foldAtomicContainers` for how we split oversized
 * atomic containers across a create + follow-up appends.
 *
 * Ref: https://developers.notion.com/reference/patch-block-children — "The
 * array of block children passed in must have a length of less than or
 * equal to 100."
 */
export const APPEND_CHILDREN_MAX = MAX_CHILDREN_PER_APPEND

type AppendLike = Extract<DiffOp, { kind: 'append' | 'insert' }>

const isAppendLike = (op: DiffOp): op is AppendLike => op.kind === 'append' || op.kind === 'insert'

/**
 * Flush a run of consecutive append/insert ops against the same parent in
 * `≤APPEND_CHILDREN_MAX`-sized batches. Positional semantics:
 *
 * - If the run starts with an `insert` carrying an `afterId`, the first
 *   batch is issued with `position: after_block = afterId`. Subsequent
 *   batches append to the tail of the previous batch's last block —
 *   which (because Notion appends in order) is the same as appending
 *   normally to the parent, since the batch just landed at the tail.
 *
 *   Concretely we *explicitly* thread `after_block` from batch N to
 *   batch N+1 using the last minted id of batch N. This keeps the
 *   insertion point stable even if someone else is concurrently
 *   appending to the same parent.
 *
 * - If the run starts with an `append` (no `afterId`), every batch is a
 *   plain tail-append.
 *
 * Each successful batch resolves the tmpId → server id for every block
 * it created, in order.
 */
/** Minimal o11y context threaded through applyDiff. Nothing allocated when `onEvent` is undefined. */
interface O11yCtx {
  readonly onEvent: SyncEventHandler | undefined
  nextOpId: () => number
  opCount: { n: number }
  /**
   * Consumer hook: given a rejected `file_upload_id`, return a fresh one. When
   * undefined, upload-id rejections surface as `NotionSyncError` with
   * `reason: 'notion-upload-id-rejected'` and an actionable message.
   */
  readonly onUploadIdRejected: OnUploadIdRejected | undefined
}

/**
 * Attempt to refresh every `file_upload_id` referenced in `propsList` via
 * the consumer hook. Returns a parallel array of refreshed props, or
 * `undefined` if no op in the batch carried an upload id (meaning the
 * original failure wasn't actually upload-id-related — surface as-is).
 *
 * Emits one `UploadIdRejected` event per refreshed op.
 */
const refreshBatchUploadIds = (
  batch: readonly {
    readonly props: Record<string, unknown>
    readonly blockId: string | undefined
    readonly tmpId: string | undefined
  }[],
  hook: OnUploadIdRejected,
  originalError: NotionApiError,
  o11y: O11yCtx,
): Effect.Effect<readonly Record<string, unknown>[] | undefined, NotionSyncError, never> =>
  Effect.gen(function* () {
    let touched = false
    const out: Record<string, unknown>[] = []
    for (const entry of batch) {
      const fileUploadId = extractFileUploadId(entry.props)
      if (fileUploadId === undefined) {
        out.push(entry.props)
        continue
      }
      touched = true
      if (o11y.onEvent !== undefined) {
        o11y.onEvent(
          SyncEvent.UploadIdRejected({
            blockId: entry.blockId,
            tmpId: entry.tmpId,
            fileUploadId,
            error: String(originalError),
            at: Date.now(),
          }),
        )
      }
      const ctx: UploadIdRejectionContext = {
        blockId: entry.blockId,
        tmpId: entry.tmpId,
        fileUploadId,
        originalError,
      }
      const { newUploadId } = yield* hook(ctx)
      out.push(replaceFileUploadId(entry.props, newUploadId))
    }
    if (!touched) return undefined
    return out
  })

const flushAppendRun = (
  run: readonly AppendLike[],
  idMap: Map<string, string>,
  resolve: (id: string) => string,
  onBatch: (
    committed: readonly { op: AppendLike; serverId: string; afterId: string | undefined }[],
  ) => Effect.Effect<void, NotionSyncError, NotionRendererClient>,
  o11y: O11yCtx,
): Effect.Effect<void, NotionSyncError, NotionRendererClient> =>
  Effect.gen(function* () {
    if (run.length === 0) return
    const parentId = resolve(run[0]!.parent)
    const first = run[0]!
    // Batch position envelope. Three cases for the *first* batch:
    //   - `append` kind, or `insert` with afterId unresolved → no envelope
    //     (tail-append, matches Notion's default).
    //   - `insert` with afterId === '' → `{ type: 'start' }` (head insert;
    //     sync-diff uses empty-string as the head marker).
    //   - `insert` with afterId !== '' → `{ type: 'after_block': ... }`.
    // For subsequent batches we always anchor on the last-minted id of the
    // prior batch so the run stays contiguous even under concurrent edits.
    type BatchPosition =
      | { readonly type: 'after_block'; readonly after_block: { readonly id: string } }
      | { readonly type: 'start' }
    let position: BatchPosition | undefined
    // `afterId` threaded to `onBatch` for the in-memory working-cache update
    // (see `workingAppend`). Empty string preserves the head-insert semantic
    // end-to-end; undefined means plain tail-append.
    let firstAfterId: string | undefined
    if (first.kind === 'insert') {
      if (first.afterId === '') {
        position = { type: 'start' as const }
        firstAfterId = ''
      } else {
        const resolved = resolve(first.afterId)
        position = { type: 'after_block' as const, after_block: { id: resolved } }
        firstAfterId = resolved
      }
    }

    let batchAfterId = firstAfterId
    for (let start = 0; start < run.length; start += APPEND_CHILDREN_MAX) {
      const batch = run.slice(start, start + APPEND_CHILDREN_MAX)
      // Track live props for each op so a retry with refreshed upload ids
      // can rebuild the batch without re-running the diff.
      let batchProps: Record<string, unknown>[] = batch.map((op) => ({ ...op.props }))
      const opId = o11y.nextOpId()
      const t0 = o11y.onEvent !== undefined ? performance.now() : 0
      if (o11y.onEvent !== undefined) {
        o11y.onEvent(SyncEvent.OpIssued({ id: opId, kind: 'append', at: Date.now() }))
      }
      const issueAppend = (props: readonly Record<string, unknown>[]) =>
        NotionBlocks.append({
          blockId: parentId,
          children: batch.map((op, i) => appendBody(op.type, props[i]!)),
          ...(position !== undefined ? { position } : {}),
        })
      const res = yield* issueAppend(batchProps).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            if (!isUploadIdRejection(cause) || o11y.onUploadIdRejected === undefined) {
              return yield* cause
            }
            const refreshed = yield* refreshBatchUploadIds(
              batch.map((op, i) => ({
                props: batchProps[i]!,
                blockId: undefined,
                tmpId: op.tmpId,
              })),
              o11y.onUploadIdRejected,
              cause,
              o11y,
            )
            if (refreshed === undefined) return yield* cause
            batchProps = refreshed.slice() as Record<string, unknown>[]
            return yield* issueAppend(batchProps)
          }),
        ),
        Effect.tapError((cause) =>
          Effect.sync(() => {
            if (o11y.onEvent !== undefined) {
              o11y.onEvent(
                SyncEvent.OpFailed({
                  id: opId,
                  kind: 'append',
                  durationMs: performance.now() - t0,
                  error: String(cause),
                  at: Date.now(),
                }),
              )
            }
          }),
        ),
        Effect.mapError((cause) => {
          if (cause instanceof NotionSyncError) return cause
          if (isUploadIdRejection(cause)) {
            return new NotionSyncError({
              reason: 'notion-upload-id-rejected',
              cause,
            })
          }
          return new NotionSyncError({
            reason: first.kind === 'insert' ? 'notion-insert-failed' : 'notion-append-failed',
            cause,
          })
        }),
      )
      o11y.opCount.n += 1
      if (o11y.onEvent !== undefined) {
        o11y.onEvent(
          SyncEvent.OpSucceeded({
            id: opId,
            kind: 'append',
            durationMs: performance.now() - t0,
            resultCount: (res.results as readonly unknown[]).length,
            at: Date.now(),
          }),
        )
        o11y.onEvent(
          SyncEvent.BatchFlush({ issued: batch.length, batched: batch.length, at: Date.now() }),
        )
      }
      // Results are returned in the order submitted.
      const results = res.results as readonly { id?: string }[]
      const committed: { op: AppendLike; serverId: string; afterId: string | undefined }[] = []
      let lastId: string | undefined
      for (let i = 0; i < batch.length; i++) {
        const serverId = results[i]?.id
        if (serverId === undefined) continue
        idMap.set(batch[i]!.tmpId, serverId)
        // First item of the batch inherits the batch-level anchor; every
        // subsequent item chains off its predecessor's server id.
        const opAfterId = i === 0 ? batchAfterId : lastId
        committed.push({ op: batch[i]!, serverId, afterId: opAfterId })
        lastId = serverId
      }
      // Anchor subsequent batches on the last-minted id so positional
      // semantics are preserved under concurrent modifications.
      if (lastId !== undefined) {
        position = { type: 'after_block' as const, after_block: { id: lastId } }
        batchAfterId = lastId
      }
      yield* onBatch(committed)
    }
  })

/**
 * Apply a pre-computed diff plan against Notion. Consecutive append/insert
 * ops sharing a parent are coalesced into batched API calls (#101).
 * Accumulates tmp-id → real-id mappings into `idMap` as the server issues
 * ids for appended / inserted blocks.
 *
 * After each successful HTTP call (batched append, single update, single
 * remove) invokes `checkpoint` with the op(s) just committed so the caller
 * can persist a partial cache snapshot (#102). If a later op throws, the
 * cache reflects server state up to the last successful checkpoint.
 */
/**
 * Atomic-container preprocessing.
 *
 * Notion rejects creating a `column_list` (and other "atomic" containers like
 * `column`) via staged-append: the parent must be created with all its
 * required children inlined in the same request. The diff plan, however,
 * emits one append per block (column_list first, then its columns, then
 * their content). That single-op flow hits a validation error from the API
 * on the first call because a column_list without columns is invalid.
 *
 * This pass folds the required children of atomic containers into the
 * container op's `props.children`. Ordinary blocks remain leaf bodies in
 * that request: their descendants are appended after their server ids have
 * been resolved. This avoids exceeding Notion's request nesting limit while
 * preserving the mandatory column_list/column/table creation shapes.
 * Absorbed ops are removed and their tmpIds resolved by recursive retrieval.
 *
 * Only newly-created subtrees are folded (append ops reachable through the
 * tmpId graph). Inserts anchored on existing blocks carry server ids and
 * are treated as independent API calls. Updates and removes are left
 * untouched.
 */
interface AbsorbedSubtree {
  /**
   * Absorbed descendants in the exact order they appear under the container,
   * depth-first, matching the shape of `props.children` shipped to Notion.
   * Used to map nested tmpIds → server ids after the atomic append returns.
   */
  readonly descendants: readonly string[]
  readonly children: readonly PendingChild[]
}

const foldAtomicContainers = (
  ops: readonly DiffOp[],
): { plan: DiffOp[]; absorbed: Map<string, AbsorbedSubtree> } => {
  // Build parent→children index over append ops only (tmpId graph). Insert
  // ops are also newly-created, but they anchor on a server id via afterId;
  // they still become children of their `parent` in the new tree. So we
  // include both `append` and `insert` in the child index, keyed by parent
  // tmpId.
  const childrenByParent = new Map<string, AppendLike[]>()
  for (const op of ops) {
    if (!isAppendLike(op)) continue
    const list = childrenByParent.get(op.parent)
    if (list === undefined) childrenByParent.set(op.parent, [op])
    else list.push(op)
  }

  const absorbed = new Map<string, AbsorbedSubtree>()
  const absorbedTmpIds = new Set<string>()

  /**
   * Build the required atomic creation shape. Do not fold children of an
   * ordinary block (such as a toggle inside a column): those can be appended
   * separately without violating its creation contract.
   * Children are capped at `MAX_CHILDREN_PER_APPEND`; top-level overflow
   * remains in the plan for subsequent batched appends.
   */
  const buildNestedBody = (
    op: AppendLike,
    descendants: string[],
    depth: number,
    isTopLevelContainer: boolean,
  ): Record<string, unknown> => {
    const kids = childrenByParent.get(op.tmpId) ?? []
    const payload: Record<string, unknown> = { ...op.props }
    // Columns are only legal inside column_list creation, so they are not
    // standalone ATOMIC_CONTAINERS but still require their first-level children.
    if (!ATOMIC_CONTAINERS.has(op.type) && op.type !== 'column') return payload
    if (kids.length > 0) {
      const inlineCount = isTopLevelContainer
        ? Math.min(kids.length, MAX_CHILDREN_PER_APPEND)
        : kids.length
      if (!isTopLevelContainer && kids.length > MAX_CHILDREN_PER_APPEND) {
        throw new Error(
          `notion-react: atomic container nested level (depth ${depth}, type ${op.type}) has ${kids.length} direct children, exceeds Notion's ${MAX_CHILDREN_PER_APPEND}-per-level cap. Nested-level chunking is not implemented — flatten the structure or file a bug.`,
        )
      }
      payload.children = kids.slice(0, inlineCount).map((k) => {
        descendants.push(k.tmpId)
        absorbedTmpIds.add(k.tmpId)
        return {
          object: 'block',
          type: k.type,
          [k.type]: buildNestedBody(k, descendants, depth + 1, false),
        }
      })
      // Overflow kids (kids.slice(inlineCount)) stay in the top-level op
      // list — they're append ops with parent=container.tmpId, and the
      // main flushAppendRun pipeline already batches at 100 per call.
    }
    return payload
  }

  const pendingChildren = (children: readonly CandidateNode[]): readonly PendingChild[] =>
    children.flatMap((child) =>
      child.blockId !== undefined && absorbedTmpIds.has(child.blockId)
        ? [
            {
              key: child.key,
              type: child.type,
              hash: child.hash,
              children: pendingChildren(child.children),
            },
          ]
        : [],
    )

  const plan: DiffOp[] = []
  for (const op of ops) {
    if (isAppendLike(op) && absorbedTmpIds.has(op.tmpId)) {
      // Already folded into an ancestor atomic container's nested payload
      // (e.g. a `table` nested inside a `column_list > column`). Must be
      // checked before the atomic-container branch so nested atomic
      // containers don't get re-folded as their own top-level API call.
      continue
    }
    if (isAppendLike(op) && ATOMIC_CONTAINERS.has(op.type)) {
      const descendants: string[] = []
      const foldedProps = buildNestedBody(op, descendants, 1, true)
      absorbed.set(op.tmpId, { descendants, children: pendingChildren(op.candidate.children) })
      // Replace the op with a version whose `props` carry nested children.
      // The op's `candidate` still references the full subtree — fine: the
      // working-cache checkpoint only records the top-level block, and final
      // `resolveTreeIds` fills nested blockIds after the retrieve pass.
      plan.push({ ...op, props: foldedProps })
    } else {
      plan.push(op)
    }
  }
  return { plan, absorbed }
}

/**
 * The one child-id read path for mandatory atomic creation payloads, used
 * immediately after append and when an interrupted lookup resumes.
 */
const resolveCreatedChildren = (
  parentId: string,
  expected: readonly PendingChild[],
): Effect.Effect<readonly CacheNode[], NotionSyncError, NotionRendererClient> =>
  Effect.gen(function* () {
    const live = Array.from(
      yield* Stream.runCollect(
        NotionBlocks.retrieveChildrenStream({ blockId: parentId }),
      ).pipe(
        Effect.mapError((cause) => new NotionSyncError({ reason: 'notion-retrieve-failed', cause })),
      ),
    )
    if (live.length !== expected.length) {
      return yield* new NotionSyncError({
        reason: 'notion-retrieve-failed',
        cause: `Created children under ${parentId}: expected ${expected.length}, observed ${live.length}; keep the pending checkpoint and reconcile.`,
      })
    }
    const children: CacheNode[] = []
    for (let index = 0; index < expected.length; index++) {
      const intent = expected[index]!
      const block = live[index]!
      if (block.type !== intent.type) {
        return yield* new NotionSyncError({
          reason: 'notion-retrieve-failed',
          cause: `Created child ${block.id}: expected ${intent.type}, observed ${block.type}; keep the pending checkpoint and reconcile.`,
        })
      }
      children.push({
        key: intent.key,
        blockId: block.id,
        type: intent.type,
        hash: intent.hash,
        children:
          intent.children.length === 0
            ? []
            : yield* resolveCreatedChildren(block.id, intent.children),
        nodeKind: 'block',
      })
    }
    return children
  })

const resolvePendingChildren = (
  cached: readonly CacheNode[],
): Effect.Effect<
  { readonly nodes: readonly CacheNode[]; readonly changed: boolean },
  NotionSyncError,
  NotionRendererClient
> =>
  Effect.gen(function* () {
    const nodes: CacheNode[] = []
    let changed = false
    for (const node of cached) {
      if (node.pendingChildren !== undefined) {
        const children = yield* resolveCreatedChildren(node.blockId, node.pendingChildren)
        nodes.push({ ...node, children, pendingChildren: undefined })
        changed = true
      } else if (node.children.length > 0) {
        const nested = yield* resolvePendingChildren(node.children)
        nodes.push(nested.changed ? { ...node, children: nested.nodes } : node)
        changed = changed || nested.changed
      } else {
        nodes.push(node)
      }
    }
    return { nodes, changed }
  })

const applyDiff = (
  ops: readonly DiffOp[],
  idMap: Map<string, string>,
  checkpoint: (
    event:
      | {
          readonly kind: 'appended'
          readonly committed: readonly {
            op: AppendLike
            serverId: string
            afterId: string | undefined
          }[]
        }
      | { readonly kind: 'updated'; readonly op: Extract<DiffOp, { kind: 'update' }> }
      | { readonly kind: 'removed'; readonly op: Extract<DiffOp, { kind: 'remove' }> },
  ) => Effect.Effect<void, NotionSyncError>,
  o11y: O11yCtx,
  priorHashById: ReadonlyMap<string, string>,
  absorbed: ReadonlyMap<string, AbsorbedSubtree>,
): Effect.Effect<void, NotionSyncError, NotionRendererClient> =>
  Effect.gen(function* () {
    const resolve = (id: string): string => idMap.get(id) ?? id
    let i = 0
    while (i < ops.length) {
      const op = ops[i]!
      if (isAppendLike(op)) {
        // Coalesce consecutive append/insert ops with the same parent into a
        // single API call — but only when the ops chain contiguously, i.e.
        // each op's `afterId` references the previous op's tmpId. Breaking
        // the run on a non-chained `insert.afterId` preserves sibling order
        // when a single sync has multiple distinct insertion points under
        // the same parent (e.g. diff of `[A,B,C]` → `[A,X,B,Y,C]` emits
        // `insert X after A` and `insert Y after B`; those must land in
        // separate batches or Y ends up adjacent to X).
        const runStart = i
        const runParent = op.parent
        const runKind = op.kind
        let prevTmpId = op.tmpId
        i += 1
        while (i < ops.length) {
          const next = ops[i]!
          if (!isAppendLike(next) || next.parent !== runParent) break
          // A run must be kind-homogeneous: a positioned-insert batch
          // carries `position: after_block(...)`, so a trailing `append`
          // would land adjacent to the last insert instead of at the
          // parent's tail. Conversely, an `insert` mid-run into a plain
          // append batch has no way to carry its anchor. Flush the run
          // before switching kinds.
          if (next.kind !== runKind) break
          // Within an insert run, each `insert` continues the run only
          // when its afterId chains off the previous op's tmpId so sibling
          // order is preserved across distinct insertion points.
          if (next.kind === 'insert' && next.afterId !== prevTmpId) break
          prevTmpId = next.tmpId
          i += 1
        }
        yield* flushAppendRun(
          ops.slice(runStart, i) as AppendLike[],
          idMap,
          resolve,
          (committed) =>
            Effect.gen(function* () {
              // The response already acknowledged these identities. Persist
              // them before a fallible GET for mandatory inline descendants.
              yield* checkpoint({ kind: 'appended', committed })
              let resolvedChildren = false
              for (const c of committed) {
                const sub = absorbed.get(c.op.tmpId)
                if (sub !== undefined && sub.descendants.length > 0) {
                  const children = yield* resolveCreatedChildren(c.serverId, sub.children)
                  let cursor = 0
                  const bind = (nodes: readonly CacheNode[]): void => {
                    for (const node of nodes) {
                      idMap.set(sub.descendants[cursor++]!, node.blockId)
                      bind(node.children)
                    }
                  }
                  bind(children)
                  resolvedChildren = true
                }
              }
              if (resolvedChildren) yield* checkpoint({ kind: 'appended', committed })
            }),
          o11y,
        )
        continue
      }
      switch (op.kind) {
        case 'update': {
          // Elide updates whose post-update hash already matches the prior
          // cached hash — e.g. re-synced after a checkpoint that already
          // landed this update, or a hash-stable field reshuffle. Surfaces
          // as UpdateNoop so consumers can measure hash churn.
          const priorHash = priorHashById.get(op.blockId)
          if (priorHash !== undefined && priorHash === op.hash) {
            if (o11y.onEvent !== undefined) {
              o11y.onEvent(
                SyncEvent.UpdateNoop({
                  id: o11y.nextOpId(),
                  blockId: op.blockId,
                  reason: 'hash-equal',
                  at: Date.now(),
                }),
              )
            }
            yield* checkpoint({ kind: 'updated', op })
            i += 1
            break
          }
          const opId = o11y.nextOpId()
          const t0 = o11y.onEvent !== undefined ? performance.now() : 0
          if (o11y.onEvent !== undefined) {
            o11y.onEvent(SyncEvent.OpIssued({ id: opId, kind: 'update', at: Date.now() }))
          }
          let updateProps: Record<string, unknown> = { ...op.props }
          const issueUpdate = (props: Record<string, unknown>) =>
            issueBlockUpdate(op.blockId, op.type, props)
          yield* issueUpdate(updateProps).pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                if (!isUploadIdRejection(cause) || o11y.onUploadIdRejected === undefined) {
                  return yield* cause
                }
                const refreshed = yield* refreshBatchUploadIds(
                  [{ props: updateProps, blockId: op.blockId, tmpId: undefined }],
                  o11y.onUploadIdRejected,
                  cause,
                  o11y,
                )
                if (refreshed === undefined) return yield* cause
                updateProps = { ...refreshed[0]! }
                return yield* issueUpdate(updateProps)
              }),
            ),
            Effect.tapError((cause) =>
              Effect.sync(() => {
                if (o11y.onEvent !== undefined) {
                  o11y.onEvent(
                    SyncEvent.OpFailed({
                      id: opId,
                      kind: 'update',
                      durationMs: performance.now() - t0,
                      error: String(cause),
                      at: Date.now(),
                    }),
                  )
                }
              }),
            ),
            Effect.mapError((cause) => {
              if (cause instanceof NotionSyncError) return cause
              if (isUploadIdRejection(cause)) {
                return new NotionSyncError({
                  reason: 'notion-upload-id-rejected',
                  cause,
                })
              }
              return new NotionSyncError({ reason: 'notion-update-failed', cause })
            }),
          )
          o11y.opCount.n += 1
          if (o11y.onEvent !== undefined) {
            o11y.onEvent(
              SyncEvent.OpSucceeded({
                id: opId,
                kind: 'update',
                durationMs: performance.now() - t0,
                resultCount: 1,
                at: Date.now(),
              }),
            )
            o11y.onEvent(SyncEvent.BatchFlush({ issued: 1, batched: 1, at: Date.now() }))
          }
          yield* checkpoint({ kind: 'updated', op })
          break
        }
        case 'remove': {
          const opId = o11y.nextOpId()
          const t0 = o11y.onEvent !== undefined ? performance.now() : 0
          if (o11y.onEvent !== undefined) {
            o11y.onEvent(SyncEvent.OpIssued({ id: opId, kind: 'delete', at: Date.now() }))
          }
          // Idempotent delete: if Notion reports the block is already
          // archived or doesn't exist, the desired end state ("gone")
          // already holds. Treat as success with a `note` so observers can
          // distinguish from a real delete (pixeltrail dogfood v5).
          const alreadyGone = yield* NotionBlocks.delete({ blockId: op.blockId }).pipe(
            Effect.map(() => false),
            Effect.catch((cause) =>
              isAlreadyGoneError(cause)
                ? Effect.succeed(true)
                : Effect.sync(() => {
                    if (o11y.onEvent !== undefined) {
                      o11y.onEvent(
                        SyncEvent.OpFailed({
                          id: opId,
                          kind: 'delete',
                          durationMs: performance.now() - t0,
                          error: String(cause),
                          at: Date.now(),
                        }),
                      )
                    }
                  }).pipe(
                    Effect.flatMap(() =>
                      Effect.fail(new NotionSyncError({ reason: 'notion-delete-failed', cause })),
                    ),
                  ),
            ),
          )
          o11y.opCount.n += 1
          if (o11y.onEvent !== undefined) {
            o11y.onEvent(
              SyncEvent.OpSucceeded({
                id: opId,
                kind: 'delete',
                durationMs: performance.now() - t0,
                resultCount: 1,
                ...(alreadyGone ? { note: 'already-archived' as const } : {}),
                at: Date.now(),
              }),
            )
            o11y.onEvent(SyncEvent.BatchFlush({ issued: 1, batched: 1, at: Date.now() }))
          }
          yield* checkpoint({ kind: 'removed', op })
          break
        }
      }
      i += 1
    }
  })

const emptyCache = (rootId: string): CacheTree => ({
  schemaVersion: CACHE_SCHEMA_VERSION,
  rootId,
  children: [],
})

interface LiveIdentityNode {
  readonly blockId: string
  readonly type: string
  readonly children: readonly LiveIdentityNode[]
}

/**
 * Block scopes whose descendants are created and reconciled by the renderer.
 *
 * This is intentionally a positive list. Opaque passthrough blocks such as
 * `synced_block` can report inherited children that belong to their source;
 * traversing those children would misclassify them as renderer drift and
 * archive content the renderer does not own.
 */
const RENDERER_OWNED_CHILD_SCOPES: Readonly<Record<string, true>> = {
  paragraph: true,
  heading_1: true,
  heading_2: true,
  heading_3: true,
  heading_4: true,
  bulleted_list_item: true,
  numbered_list_item: true,
  to_do: true,
  toggle: true,
  quote: true,
  callout: true,
  table: true,
  column_list: true,
  column: true,
}

type RetrieveO11yCtx = Pick<O11yCtx, 'onEvent' | 'nextOpId' | 'opCount'>

const childrenSettleSchedule = Schedule.exponential(Duration.millis(500), 1.5).pipe(
  Schedule.upTo({ times: 4 }),
)

/**
 * Issue one physical children-list request and account for it exactly once.
 * Pagination and settled-read retries both pass through this boundary.
 */
const retrieveLiveIdentityPage = (
  parentId: string,
  startCursor: string | undefined,
  o11y: RetrieveO11yCtx,
) =>
  Effect.gen(function* () {
    const opId = o11y.nextOpId()
    const t0 = o11y.onEvent !== undefined ? performance.now() : 0
    o11y.opCount.n += 1
    o11y.onEvent?.(SyncEvent.OpIssued({ id: opId, kind: 'retrieve', at: Date.now() }))
    const page = yield* NotionBlocks.retrieveChildren({
      blockId: parentId,
      ...(startCursor !== undefined ? { startCursor } : {}),
    }).pipe(
      Effect.mapError((cause) => new NotionSyncError({ reason: 'notion-retrieve-failed', cause })),
      Effect.tapError((cause) =>
        Effect.sync(() => {
          o11y.onEvent?.(
            SyncEvent.OpFailed({
              id: opId,
              kind: 'retrieve',
              durationMs: performance.now() - t0,
              error: String(cause),
              at: Date.now(),
            }),
          )
        }),
      ),
    )
    o11y.onEvent?.(
      SyncEvent.OpSucceeded({
        id: opId,
        kind: 'retrieve',
        durationMs: performance.now() - t0,
        resultCount: page.results.length,
        at: Date.now(),
      }),
    )
    return page
  })

/**
 * Retrieve every page of direct children. When the parent explicitly promised
 * children, a transiently empty aggregate is retried with the repository's
 * bounded settle schedule; exhausting that budget fails closed.
 */
const retrieveLiveIdentityChildren = (
  parentId: string,
  expectChildren: boolean,
  o11y: RetrieveO11yCtx,
) =>
  Effect.gen(function* () {
    const blocks = []
    let startCursor: string | undefined
    do {
      const page = yield* retrieveLiveIdentityPage(parentId, startCursor, o11y)
      blocks.push(...page.results)
      startCursor =
        page.hasMore === true && Option.isSome(page.nextCursor) === true
          ? page.nextCursor.value
          : undefined
    } while (startCursor !== undefined)
    if (expectChildren && blocks.length === 0) {
      return yield* new NotionSyncError({
        reason: 'children-not-yet-visible',
        cause: parentId,
      })
    }
    return blocks
  }).pipe(
    Effect.retry({
      schedule: childrenSettleSchedule,
      while: (error) => error.reason === 'children-not-yet-visible',
    }),
  )

/**
 * Observe the ordered live identity tree below a page or block. Warm-cache
 * drift detection recurses only through renderer-owned block scopes and
 * through every child-page boundary; cold cleanup only needs root children.
 */
const retrieveLiveIdentities: (
  parentId: string,
  recursive: boolean,
  o11y: RetrieveO11yCtx,
  expectChildren?: boolean,
  excludedChildId?: string,
) => Effect.Effect<readonly LiveIdentityNode[], NotionSyncError, NotionRendererClient> = Effect.fn(
  'notion-react.retrieve-live-identities',
)(function* (
  parentId: string,
  recursive: boolean,
  o11y: RetrieveO11yCtx,
  expectChildren = false,
  excludedChildId?: string,
) {
  const live = yield* retrieveLiveIdentityChildren(parentId, expectChildren, o11y)
  const identities: LiveIdentityNode[] = []
  for (const block of live) {
    if (block.in_trash === true || block.id === excludedChildId) continue
    const ownsChildScope =
      block.type === 'child_page' || RENDERER_OWNED_CHILD_SCOPES[block.type] === true
    const children =
      recursive && ownsChildScope && (block.has_children === true || block.type === 'child_page')
        ? yield* retrieveLiveIdentities(
            block.id,
            true,
            o11y,
            block.has_children === true,
            excludedChildId,
          )
        : []
    identities.push({ blockId: block.id, type: block.type, children })
  }
  return identities
})

/** Index page nodes globally by durable ID; ordinary blocks remain scope-local. */
const indexCachedPagesByBlockId = (nodes: readonly CacheNode[]): Map<string, CacheNode> => {
  const pages = new Map<string, CacheNode>()
  const walk = (children: readonly CacheNode[]): void => {
    for (const child of children) {
      if (child.nodeKind === 'page') pages.set(child.blockId, child)
      walk(child.children)
    }
  }
  walk(nodes)
  return pages
}

/**
 * Build a cache-shaped base from the recursive live identity tree on drift.
 *
 * Prior entries whose identities are still live retain their key/hash data,
 * while untracked live entries become synthetic ghosts that the diff removes.
 * The same rule is applied at every nested block and child-page scope, so a
 * stale cache cannot blindly re-append descendants that already landed.
 */
const mergeLiveIdentityBase = (
  liveNodes: readonly LiveIdentityNode[],
  priorNodes: readonly CacheNode[],
  priorPageByBlockId: ReadonlyMap<string, CacheNode>,
  preserveKindInterleaving = false,
): readonly CacheNode[] => {
  const priorByBlockId = new Map(priorNodes.map((node) => [node.blockId, node]))
  const globallyRecoveredPageIds = new Set<string>()
  const mergedWithRecoveredPages = liveNodes.map((liveNode): CacheNode => {
    const localPriorNode = priorByBlockId.get(liveNode.blockId)
    const globalPriorPage =
      liveNode.type === 'child_page' ? priorPageByBlockId.get(liveNode.blockId) : undefined
    const priorNode = localPriorNode ?? globalPriorPage
    if (localPriorNode === undefined && globalPriorPage !== undefined) {
      globallyRecoveredPageIds.add(liveNode.blockId)
    }
    if (priorNode !== undefined) {
      return {
        ...priorNode,
        children: mergeLiveIdentityBase(
          liveNode.children,
          priorNode.children,
          priorPageByBlockId,
          priorNode.nodeKind === 'page',
        ),
      }
    }
    return {
      key: `drift:${liveNode.blockId}`,
      blockId: liveNode.blockId,
      type: liveNode.type,
      hash: '',
      children: mergeLiveIdentityBase(liveNode.children, [], priorPageByBlockId),
      nodeKind: liveNode.type === 'child_page' ? 'page' : 'block',
    }
  })

  // A blockKey is only unique within its original parent. If global recovery
  // relocates a page beside another page with the same key, retaining either
  // key would make the sibling cache invalid or let the global move index pick
  // the wrong identity. Demote every member of the colliding set to a ghost so
  // the existing ambiguous-key policy safely rebuilds them all.
  const pageCountByKey = new Map<string, number>()
  for (const node of mergedWithRecoveredPages) {
    if (node.nodeKind !== 'page' || node.key.startsWith('drift:')) continue
    pageCountByKey.set(node.key, (pageCountByKey.get(node.key) ?? 0) + 1)
  }
  const collidedRecoveredKeys = new Set<string>()
  for (const node of mergedWithRecoveredPages) {
    if (globallyRecoveredPageIds.has(node.blockId) && (pageCountByKey.get(node.key) ?? 0) > 1) {
      collidedRecoveredKeys.add(node.key)
    }
  }
  const merged = mergedWithRecoveredPages.map((node): CacheNode => {
    if (node.nodeKind !== 'page' || !collidedRecoveredKeys.has(node.key)) return node
    return {
      key: `drift:${node.blockId}`,
      blockId: node.blockId,
      type: node.type,
      hash: '',
      children: node.children,
      nodeKind: 'page',
    }
  })
  if (!preserveKindInterleaving) return merged

  const retainedBlocks = merged.filter(
    (node) => !node.key.startsWith('drift:') && node.nodeKind === 'block',
  )
  const retainedPages = merged.filter(
    (node) => !node.key.startsWith('drift:') && node.nodeKind === 'page',
  )
  const ordered: CacheNode[] = []
  let blockIndex = 0
  let pageIndex = 0
  for (const priorNode of priorNodes) {
    const node =
      priorNode.nodeKind === 'page' ? retainedPages[pageIndex++] : retainedBlocks[blockIndex++]
    if (node !== undefined) ordered.push(node)
  }
  ordered.push(
    ...retainedBlocks.slice(blockIndex),
    ...retainedPages.slice(pageIndex),
    ...merged.filter((node) => node.key.startsWith('drift:')),
  )
  return ordered
}

const driftedBase = (
  rootId: string,
  live: readonly LiveIdentityNode[],
  prior: CacheTree | undefined,
): CacheTree => {
  const priorChildren = prior?.children ?? []
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    rootId,
    children: mergeLiveIdentityBase(live, priorChildren, indexCachedPagesByBlockId(priorChildren)),
  }
}

/** Remove synthetic drift entries before a working cache can be checkpointed. */
const withoutDriftGhosts = (nodes: readonly CacheNode[]): readonly CacheNode[] =>
  nodes.flatMap((node) =>
    node.key.startsWith('drift:') ? [] : [{ ...node, children: withoutDriftGhosts(node.children) }],
  )

/**
 * Compare recursive identities. Root and ordinary block children are ordered.
 * Child-page content ignores unstable block/page interleaving while preserving
 * relative order within the block siblings and page siblings.
 */
const identityTreeDrifted = (
  expected: readonly CacheNode[],
  live: readonly LiveIdentityNode[],
  ordered = true,
): boolean => {
  if (live.length !== expected.length) return true
  if (ordered) {
    for (let index = 0; index < expected.length; index++) {
      const expectedNode = expected[index]!
      const liveNode = live[index]!
      if (liveNode.blockId !== expectedNode.blockId) return true
      if (
        identityTreeDrifted(
          expectedNode.children,
          liveNode.children,
          expectedNode.nodeKind !== 'page',
        )
      )
        return true
    }
    return false
  }
  for (const nodeKind of ['block', 'page'] as const) {
    const expectedOfKind = expected.filter((node) => node.nodeKind === nodeKind)
    const liveOfKind = live.filter(
      (node) => (node.type === 'child_page' ? 'page' : 'block') === nodeKind,
    )
    if (identityTreeDrifted(expectedOfKind, liveOfKind)) return true
  }
  return false
}

/**
 * Select the tree the diff runs against plus the fallback classification.
 * Pure function of the cache/drift inputs so `sync()` and `plan()` cannot
 * disagree about which base a given state diffs against.
 */
const selectDiffBase = ({
  pageId,
  prior,
  schemaMismatch,
  pageIdDrift,
  coldBaseline,
  drifted,
  liveIdentities,
}: {
  readonly pageId: string
  readonly prior: CacheTree | undefined
  readonly schemaMismatch: boolean
  readonly pageIdDrift: boolean
  readonly coldBaseline: ColdBaseline
  readonly drifted: boolean
  readonly liveIdentities: readonly LiveIdentityNode[]
}): {
  readonly useCold: boolean
  readonly coldClean: boolean
  readonly diffBase: CacheTree
  readonly fallbackReason: SyncFallbackReason | undefined
} => {
  const useCold = prior === undefined || pageIdDrift
  const coldClean = useCold && coldBaseline === 'clean' && liveIdentities.length > 0
  const diffBase: CacheTree = useCold
    ? coldClean
      ? driftedBase(pageId, liveIdentities, undefined)
      : emptyCache(pageId)
    : drifted
      ? driftedBase(pageId, liveIdentities, prior)
      : (prior ?? emptyCache(pageId))
  const fallbackReason: SyncFallbackReason | undefined = pageIdDrift
    ? 'page-id-drift'
    : drifted
      ? 'cache-drift'
      : prior === undefined
        ? 'cold-cache'
        : schemaMismatch
          ? 'schema-mismatch'
          : undefined
  return { useCold, coldClean, diffBase, fallbackReason }
}

/**
 * Root-page metadata drift (issue #618 phase 3b/4b) expressed as the
 * `updatePage` op `sync()` would apply against the sync root, or `undefined`
 * when nothing drifted. Shared between `sync()` (which applies it) and
 * `plan()` (which reports it) so the two cannot disagree about root-metadata
 * convergence.
 */
const rootPageUpdateOpFor = ({
  candidate,
  prior,
  pageId,
}: {
  readonly candidate: CandidateTree
  readonly prior: CacheTree | undefined
  readonly pageId: string
}): Extract<PageOp, { kind: 'updatePage' }> | undefined => {
  const rootPage = candidate.rootPage
  if (rootPage === undefined) return undefined
  const titleDrift = rootPage.titleHash !== undefined && rootPage.titleHash !== prior?.rootTitleHash
  // Phase 4b (#618): `null` sentinel on fresh root (no prior icon) is a
  // no-op; the candidate null hash matches "unset" server state. Once a
  // prior hash exists, candidate `null` drifts and emits `icon: null`.
  const iconDrift = iconOrCoverDrift(rootPage.iconHash, prior?.rootIconHash)
  const coverDrift = iconOrCoverDrift(rootPage.coverHash, prior?.rootCoverHash)
  if (!titleDrift && !iconDrift && !coverDrift) return undefined
  return {
    kind: 'updatePage',
    pageId,
    ...(titleDrift ? { title: rootPage.title } : {}),
    ...(iconDrift ? { icon: rootPage.icon } : {}),
    ...(coverDrift ? { cover: rootPage.cover } : {}),
  }
}

/**
 * Cache-backed incremental sync.
 *
 * Renders the JSX into an in-memory candidate tree, diffs it against the
 * cached tree (or an empty tree for cold-start), applies the minimum
 * sequence of append/insert/update/remove ops against Notion, then
 * persists the fresh cache snapshot.
 *
 * Key identity comes from an explicit `blockKey` prop on host elements.
 * When absent, siblings fall back to positional keys (`p:0`, `p:1`, ...),
 * which means unkeyed mid-sibling inserts degrade to reorders (remove +
 * re-insert of the tail). Supply `blockKey` for any collection that can
 * reorder or grow in the middle.
 *
 * `fallbackReason` is set when schema incompatibility forces a full rebuild.
 * Notion has no "move" API, so reorders always materialize as
 * `{inserts, removes}` pairs — this is documented behaviour, not a fallback.
 */
/**
 * Cold-sync baseline strategy.
 *
 * `'clean'` (default): when the sync takes a cold-cache fallback (no prior
 * cache, schema-incompatible cache, or page-id drift), first archive every
 * live top-level child of the page so the subsequent append plan lands
 * against an empty baseline that matches the cache intent. Prevents
 * leftover blocks — written by a prior run against a different cache, or
 * by a different consumer — from leaking into the next warm sync's
 * drift-recovery path (pixeltrail dogfood v5: warm sync saw 13 stale blocks,
 * issued deletes against them, and the first 400-response-on-archive aborted
 * the entire batch).
 *
 * `'merge'`: preserve any existing children of the live page. The
 * candidate tree is appended on top; subsequent warm syncs will classify
 * the unowned blocks as drift and re-emit removes for them (now idempotent
 * via `isAlreadyGoneError`, so convergence eventually happens — but the
 * first warm sync will do extra work). Choose this when the target page is
 * shared with non-sync writers whose content must be preserved.
 */
export type ColdBaseline = 'clean' | 'merge'

export const syncWithClient = (
  element: ReactNode,
  opts: {
    readonly pageId: string
    readonly cache: NotionCache
    readonly onEvent?: SyncEventHandler
    /**
     * Higher-level observability hook. When provided, `sync()` installs a
     * `SyncMetrics` aggregator over the event stream and invokes this
     * callback exactly once — after `SyncEnd` — with the consolidated
     * snapshot (actual vs theoretical op counts, OER, cache outcome,
     * etc.). Combinable with `onEvent`: both fire independently.
     */
    readonly onMetrics?: (metrics: SyncMetrics) => void
    /**
     * How to treat pre-existing live children on a cold-cache sync. See
     * {@link ColdBaseline}. Defaults to `'clean'` — the pixeltrail / general
     * single-writer sync contract.
     */
    readonly coldBaseline?: ColdBaseline
    /**
     * Consumer hook invoked when a Notion op fails with a validation_error
     * referencing a `file_upload_id` (evicted early, not-yet-usable, race).
     * Return a fresh upload id — the library retries the failing op once
     * with the replacement. When unset, such failures surface as
     * `NotionSyncError { reason: 'notion-upload-id-rejected' }`.
     *
     * The hook is library-agnostic: it only knows about the rejected id and
     * receives the originating block/tmpId for context. All upload state
     * (cache, HTTP client, logging) must be pre-provided on the returned
     * Effect — mirroring `NotionCache.save/load`.
     */
    readonly onUploadIdRejected?: OnUploadIdRejected
    /**
     * Issue #618 phase 4d: opt-in intra-parent `<ChildPage>` reorder. When
     * enabled, retained-by-blockKey page siblings whose order differs from
     * the cache's order emit a single `reorderPages` op that the driver
     * realizes via 2N `pages.move` roundtrips through a holding parent
     * (Notion's `pages.move` rejects same-parent, but a trip to any other
     * parent and back bumps the page to the end of the original parent's
     * `child_page` list — see `tmp/notion-618/options-ordering.md`).
     *
     * - `undefined` / `false` (default): retained-but-reshuffled page
     *   siblings still emit `movePage` with the same parent; the API
     *   rejects it and the driver swallows the validation error. Sibling
     *   order on the server stays as it was.
     * - `true`: library auto-provisions a single scratch page under the
     *   reordered siblings' parent (title: "@overeng/notion-react holding
     *   (do not touch)"), reuses it across syncs via the cache, and archives
     *   it between reorder bursts.
     * - `{ holdingParentId }`: caller supplies a workspace-accessible page
     *   id. The library never archives caller-supplied holding parents.
     */
    readonly reorderSiblings?: boolean | { readonly holdingParentId: string }
    /**
     * Page-lifecycle mode (#1124). `'managed'` (default) keeps the full
     * existing contract. `'append-only'` guarantees the sync never
     * archives, moves, or reorders a page and never creates one out of
     * tail position: a single post-diff predicate
     * ({@link pageLifecycleViolations}) rejects the WHOLE sync — no op
     * applied — with `NotionSyncError { reason:
     * 'page-lifecycle-violation', violations }`. Block ops and page
     * content (`updatePage`) stay fully managed. #1100 pending-adoption
     * (read + cache-save) still runs — crash recovery stays legal.
     */
    readonly pageLifecycle?: PageLifecycle
  },
): Effect.Effect<SyncResult, NotionSyncError, NotionRendererClient> => {
  /* Compose the user `onEvent` with an internal metrics aggregator iff
     `onMetrics` was supplied. Fan-out is cheap: both handlers receive
     every event. The aggregator's `getMetrics()` is called once after
     SyncEnd (both the success and error tail-branch — see bottom of this
     function / the tapError below). Hoisted out of the gen so the
     tapError branch can reach `metricsAgg`. */
  const userOnEvent = opts.onEvent
  const metricsAgg = opts.onMetrics !== undefined ? aggregateMetrics() : undefined
  const onEvent: SyncEventHandler | undefined =
    userOnEvent !== undefined && metricsAgg !== undefined
      ? (e) => {
          userOnEvent(e)
          metricsAgg.handler(e)
        }
      : (userOnEvent ?? metricsAgg?.handler)
  /* Hoisted out of the gen so the failure `tapError` branch below can emit
     a SyncEnd event with the real runtime/op-count counters instead of
     zeros (those would make partial-failure dashboards useless). */
  const syncStartMs = onEvent !== undefined ? performance.now() : 0
  let opIdCounter = 0
  const o11y: O11yCtx = {
    onEvent,
    nextOpId: () => {
      opIdCounter += 1
      return opIdCounter
    },
    opCount: { n: 0 },
    onUploadIdRejected: opts.onUploadIdRejected,
  }
  return Effect.gen(function* () {
    let prior = yield* opts.cache.load.pipe(
      Effect.mapError((cause) => new NotionSyncError({ reason: 'cache-load-failed', cause })),
    )
    const candidate = buildCandidateTree(element, opts.pageId)
    if (onEvent !== undefined) {
      onEvent(
        SyncEvent.SyncStart({
          pageId: opts.pageId,
          rootBlockCount: candidate.children.length,
          at: Date.now(),
        }),
      )
    }
    if (
      prior !== undefined &&
      prior.rootId === opts.pageId &&
      prior.schemaVersion === CACHE_SCHEMA_VERSION
    ) {
      const resolved = yield* resolvePendingChildren(prior.children)
      if (resolved.changed) {
        prior = { ...prior, children: resolved.nodes }
        yield* opts.cache.save(prior).pipe(
          Effect.mapError((cause) => new NotionSyncError({ reason: 'cache-save-failed', cause })),
        )
      }
    }

    const coldBaseline: ColdBaseline = opts.coldBaseline ?? 'clean'

    const schemaMismatch = prior !== undefined && prior.schemaVersion !== CACHE_SCHEMA_VERSION
    // Cache was written for a different page. Treat as a cold start: the prior
    // tree references block ids that don't live under this pageId, so diffing
    // would emit mutations against the wrong page. Common causes: shared cache
    // file between scripts, or a pageId env var that moved.
    const pageIdDrift = prior !== undefined && prior.rootId !== opts.pageId
    // On schema mismatch we still diff against the stale tree — keys and
    // hashes remain meaningful enough to avoid duplicate content. Migrations
    // that require a hard rebuild should bump the schema explicitly and
    // clear the cache out-of-band.

    // Pre-flight drift detection (#105). A usable warm cache is compared with
    // the ordered live identity tree recursively, including child-page scopes.
    // A stale nested cache is unsafe for the same reason as a stale root: the
    // diff would append already-live descendants and then persist a snapshot
    // that omits those duplicate identities. Cold-clean only needs root ids,
    // because removing a root subtree removes all of its descendants.
    const useColdPath = prior === undefined || pageIdDrift

    let drifted = false
    let liveIdentities: readonly LiveIdentityNode[] = []
    // Retrieve live identities when either (a) we have a warm cache and want
    // recursive drift detection, or (b) the cold-clean path needs root ids to
    // synthesize removals for existing content.
    const wantsLiveRetrieve =
      (prior !== undefined && !schemaMismatch && !pageIdDrift) ||
      (useColdPath && coldBaseline === 'clean')
    if (wantsLiveRetrieve) {
      const recursive = prior !== undefined && !schemaMismatch && !pageIdDrift
      const holdingParentId =
        typeof opts.reorderSiblings === 'object' ? opts.reorderSiblings.holdingParentId : undefined
      liveIdentities = yield* retrieveLiveIdentities(
        opts.pageId,
        recursive,
        o11y,
        false,
        holdingParentId,
      )
      // Drift detection only applies to the warm-cache path; the cold path
      // always cleans pre-existing children when `coldBaseline === 'clean'`.
      if (prior !== undefined && !schemaMismatch && !pageIdDrift) {
        drifted = identityTreeDrifted(prior.children, liveIdentities)
      }
    }

    // `diffBase` carries the recursive live identity shape on warm drift:
    // retained cache nodes keep their keys and hashes while untracked live
    // nodes become `drift:*` ghosts that the normal diff removes. The working
    // cache strips those ghosts at every depth so a mid-sync checkpoint can
    // never persist them; successful operations repopulate confirmed nodes.
    const { useCold, diffBase, fallbackReason } = selectDiffBase({
      pageId: opts.pageId,
      prior,
      schemaMismatch,
      pageIdDrift,
      coldBaseline,
      drifted,
      liveIdentities,
    })
    const workingBase: CacheTree = useCold
      ? emptyCache(opts.pageId)
      : drifted
        ? {
            schemaVersion: CACHE_SCHEMA_VERSION,
            rootId: opts.pageId,
            children: withoutDriftGhosts(diffBase.children),
          }
        : (prior ?? emptyCache(opts.pageId))

    if (onEvent !== undefined) {
      const cacheKind: 'hit' | 'miss' | 'drift' | 'page-id-drift' = pageIdDrift
        ? 'page-id-drift'
        : drifted
          ? 'drift'
          : prior === undefined || schemaMismatch
            ? 'miss'
            : 'hit'
      onEvent(SyncEvent.CacheOutcome({ kind: cacheKind, pageId: opts.pageId, at: Date.now() }))
      if (fallbackReason !== undefined) {
        onEvent(SyncEvent.FallbackTriggered({ reason: fallbackReason, at: Date.now() }))
      }
    }

    const plan = diff(diffBase, candidate, {
      reorderSiblings: opts.reorderSiblings !== undefined && opts.reorderSiblings !== false,
    })
    if (onEvent !== undefined) {
      const tally = tallyDiff(plan)
      onEvent(
        SyncEvent.PlanComputed({
          pageId: opts.pageId,
          appends: tally.appends,
          inserts: tally.inserts,
          updates: tally.updates,
          removes: tally.removes,
          at: Date.now(),
        }),
      )
    }
    // #1124: the single append-only enforcement point — a pure predicate over
    // the computed plan, evaluated before ANY op applies. Everything below
    // this line mutates (root updatePage, interleaved block/page apply), so
    // the check must sit exactly here. Fail, not skip: dropping the
    // offending ops would silently diverge server from cache.
    if (opts.pageLifecycle === 'append-only') {
      const violations = pageLifecycleViolations({ ops: plan, candidate })
      if (violations.length > 0) {
        return yield* new NotionSyncError({ reason: 'page-lifecycle-violation', violations })
      }
    }
    // Mandatory table/column descendants may occur beyond a page boundary in
    // the BFS plan. Fold them before splitting the execution into block runs.
    const { plan: executionPlan, absorbed } = foldAtomicContainers(plan)
    // Prior hashes indexed by server block id — for UpdateNoop detection
    // when diff emits an update whose hash already matches the cached one
    // (e.g. post-checkpoint retry, hash-stable reshuffle).
    const priorHashById = new Map<string, string>()
    const indexHash = (n: CacheNode): void => {
      priorHashById.set(n.blockId, n.hash)
      for (const c of n.children) indexHash(c)
    }
    if (prior !== undefined && !pageIdDrift && !drifted) {
      for (const c of prior.children) indexHash(c)
    }
    const idMap = new Map<string, string>()
    const candidateByPlaceholderId = new Map<string, CandidateNode>()
    const indexCandidate = (node: CandidateNode): void => {
      if (node.blockId !== undefined) candidateByPlaceholderId.set(node.blockId, node)
      for (const child of node.children) indexCandidate(child)
    }
    for (const child of candidate.children) indexCandidate(child)
    // Working copy of the cache tree — updated after each successful op,
    // flushed to the backend as a per-batch checkpoint (#102). On
    // mid-sync failure the cache reflects server state up to the last
    // checkpoint, so a retry diffs against a tree that already includes
    // the blocks that actually landed.
    const working = initWorkingCache(workingBase)
    const flushCheckpoint: Effect.Effect<void, NotionSyncError> = Effect.suspend(() =>
      opts.cache.save(workingToCacheTree(working)).pipe(
        Effect.mapError((cause) => new NotionSyncError({ reason: 'cache-save-failed', cause })),
        Effect.tap(() =>
          Effect.sync(() => {
            if (onEvent !== undefined) {
              onEvent(SyncEvent.CheckpointWritten({ pageId: opts.pageId, at: Date.now() }))
            }
          }),
        ),
      ),
    )

    const resolve = (id: string): string => idMap.get(id) ?? id
    /**
     * Build a WorkingNode subtree from a candidate, resolving tmpIds via the
     * idMap. Used for atomic-container appends whose descendants land in the
     * same API call (absorbed via `foldAtomicContainers`). Without this, the
     * checkpoint snapshot would record the container with `children: []`,
     * even though the server has the full subtree — which corrupts both the
     * cache-size accounting (descendants lost → next warm sync sees a
     * structural mismatch and rebuilds, doubling the subtree in the final
     * authoritative save) and mid-sync-failure recovery (a subsequent warm
     * sync would diff against an empty subtree and re-emit redundant
     * appends). Any candidate descendant whose tmpId isn't in `idMap` is
     * skipped — that's the "children from a follow-up append" case where the
     * candidate branch hasn't been committed yet. Pixeltrail dogfood v8:
     * cache inflated 609 → 710 nodes after a warm sync because absorbed
     * column_list descendants were dropped from the working cache; the final
     * `candidateToCache` recovered the shape, but any mid-flight checkpoint
     * or pre-commit inspection saw the hollowed tree.
     */
    const buildSubtreeFromCandidate = (cand: CandidateNode): WorkingNode | undefined => {
      const resolvedId =
        cand.blockId === undefined || cand.blockId.startsWith('tmp-')
          ? idMap.get(cand.blockId ?? '')
          : cand.blockId
      if (resolvedId === undefined) return undefined
      const kids: WorkingNode[] = []
      for (const c of cand.children) {
        const sub = buildSubtreeFromCandidate(c)
        if (sub !== undefined) kids.push(sub)
      }
      return {
        key: cand.key,
        blockId: resolvedId,
        type: cand.type,
        hash: cand.hash,
        children: kids,
        nodeKind: cand.nodeKind,
        ...(cand.titleHash !== undefined ? { titleHash: cand.titleHash } : {}),
        ...(cand.iconHash !== undefined ? { iconHash: cand.iconHash } : {}),
        ...(cand.coverHash !== undefined ? { coverHash: cand.coverHash } : {}),
      }
    }
    const checkpointAppended = (
      event: Parameters<Parameters<typeof applyDiff>[2]>[0],
    ): Effect.Effect<void, NotionSyncError> =>
      Effect.gen(function* () {
        if (event.kind === 'appended') {
          for (const { op, serverId, afterId } of event.committed) {
            const parentId = resolve(op.parent)
            const atomic = absorbed.get(op.tmpId)
            const pendingChildren = atomic?.descendants.some((id) => !idMap.has(id))
              ? atomic.children
              : undefined
            const children: WorkingNode[] = []
            for (const c of op.candidate.children) {
              const sub = buildSubtreeFromCandidate(c)
              if (sub !== undefined) children.push(sub)
            }
            const node: WorkingNode = {
              key: op.candidate.key,
              blockId: serverId,
              type: op.type,
              hash: op.candidate.hash,
              children,
              nodeKind: op.candidate.nodeKind,
              ...(pendingChildren !== undefined ? { pendingChildren } : {}),
              ...(op.candidate.titleHash !== undefined
                ? { titleHash: op.candidate.titleHash }
                : {}),
              ...(op.candidate.iconHash !== undefined ? { iconHash: op.candidate.iconHash } : {}),
              ...(op.candidate.coverHash !== undefined
                ? { coverHash: op.candidate.coverHash }
                : {}),
            }
            workingAppend(working, parentId, node, afterId)
          }
        } else if (event.kind === 'updated') {
          workingUpdate(working, event.op.blockId, event.op.type, event.op.hash)
        } else {
          workingRemove(working, event.op.blockId)
        }
        yield* flushCheckpoint
      })

    // Metadata updates, archives and explicit reorders are applied after the
    // candidate-ordered create/move/append pass below.
    const pageOps: PageOp[] = []
    for (const op of plan) {
      if (
        op.kind === 'createPage' ||
        op.kind === 'updatePage' ||
        op.kind === 'archivePage' ||
        op.kind === 'movePage' ||
        op.kind === 'reorderPages'
      ) {
        pageOps.push(op)
      }
    }

    // Root-page metadata update (candidate <Page> vs prior cache root hashes).
    // Emits a single `pages.update` when any of title/icon/cover drifted.
    let pageCounts: PageOpCounts = emptyPageCounts()
    const rootPage = candidate.rootPage
    const rootUpdateOp = rootPageUpdateOpFor({ candidate, prior, pageId: opts.pageId })
    if (rootUpdateOp !== undefined) {
      const opId = o11y.nextOpId()
      const t0 = performance.now()
      if (onEvent !== undefined) {
        onEvent(
          SyncEvent.PageOpIssued({
            id: opId,
            kind: 'updatePage',
            pageId: opts.pageId,
            at: Date.now(),
          }),
        )
      }
      yield* NotionPages.update({
        pageId: opts.pageId,
        ...(rootUpdateOp.title !== undefined
          ? { properties: { title: { title: rootUpdateOp.title as never } } }
          : {}),
        ...(rootUpdateOp.icon !== undefined ? { icon: rootUpdateOp.icon as never } : {}),
        ...(rootUpdateOp.cover !== undefined ? { cover: rootUpdateOp.cover as never } : {}),
      }).pipe(
        Effect.mapError(
          (cause) => new NotionSyncError({ reason: 'notion-page-update-failed', cause }),
        ),
      )
      if (onEvent !== undefined) {
        onEvent(
          SyncEvent.PageOpApplied({
            id: opId,
            kind: 'updatePage',
            pageId: opts.pageId,
            durationMs: performance.now() - t0,
            at: Date.now(),
          }),
        )
      }
      o11y.opCount.n += 1
      pageCounts = { ...pageCounts, updates: pageCounts.updates + 1 }
    }

    const runCreatePage = (op: Extract<PageOp, { kind: 'createPage' }>) =>
      Effect.gen(function* () {
        const opId = o11y.nextOpId()
        const t0 = performance.now()
        if (onEvent !== undefined) {
          onEvent(
            SyncEvent.PageOpIssued({
              id: opId,
              kind: 'createPage',
              pageId: op.tmpPageId,
              at: Date.now(),
            }),
          )
        }
        const resolvedParentId = resolve(op.parent.pageId)
        const created = yield* NotionPages.create({
          parent: { type: 'page_id', page_id: resolvedParentId },
          properties:
            op.title !== undefined
              ? { title: { title: op.title as never } }
              : { title: { title: [] } },
          ...(op.icon !== undefined ? { icon: op.icon as never } : {}),
          ...(op.cover !== undefined ? { cover: op.cover as never } : {}),
        }).pipe(
          Effect.mapError(
            (cause) => new NotionSyncError({ reason: 'notion-page-create-failed', cause }),
          ),
        )
        const createdId = (created as { id?: string }).id
        if (createdId === undefined) {
          return yield* new NotionSyncError({
            reason: 'notion-page-create-failed',
            cause: 'no id in response',
          })
        }
        idMap.set(op.tmpPageId, createdId)
        const pageCandidate = candidateByPlaceholderId.get(op.tmpPageId)
        if (pageCandidate === undefined) {
          return yield* new NotionSyncError({
            reason: 'notion-page-create-failed',
            cause: `missing candidate for ${op.tmpPageId}`,
          })
        }
        const pageNode = buildSubtreeFromCandidate(pageCandidate)
        if (pageNode === undefined) {
          return yield* new NotionSyncError({
            reason: 'notion-page-create-failed',
            cause: `unresolved created page ${op.tmpPageId}`,
          })
        }
        workingAppend(working, resolvedParentId, pageNode, undefined)
        yield* flushCheckpoint

        // A later append failure must preserve this irreversible identity and
        // every acknowledged child checkpoint, never archive the created page.

        if (onEvent !== undefined) {
          onEvent(
            SyncEvent.PageOpApplied({
              id: opId,
              kind: 'createPage',
              pageId: op.tmpPageId,
              resolvedPageId: createdId,
              durationMs: performance.now() - t0,
              at: Date.now(),
            }),
          )
        }
        o11y.opCount.n += 1
        pageCounts = { ...pageCounts, creates: pageCounts.creates + 1 }
      })

    const runMovePage = (op: Extract<PageOp, { kind: 'movePage' }>) =>
      Effect.gen(function* () {
        const opId = o11y.nextOpId()
        const t0 = performance.now()
        if (onEvent !== undefined) {
          onEvent(
            SyncEvent.PageOpIssued({
              id: opId,
              kind: 'movePage',
              pageId: op.pageId,
              at: Date.now(),
            }),
          )
        }
        // Phase 4d (#618): same-parent moves are an API-level no-op in real
        // Notion (it rejects with "New parent must be different from the
        // current parent"). The existing contract has always been "emit
        // movePage for sibling reshuffle, accept that the order doesn't
        // actually change" — swallow the validation error so the sync still
        // counts the intent. Callers who want intra-parent reorder to
        // actually land opt into `reorderSiblings`, which emits
        // `reorderPages` instead of same-parent `movePage`.
        yield* NotionPages.move({
          pageId: op.pageId,
          parent: { type: 'page_id', page_id: resolve(op.parent.pageId) },
        }).pipe(
          Effect.catch((cause) =>
            cause instanceof NotionApiError &&
            cause.code === 'validation_error' &&
            /must be different from the current parent/i.test(cause.message)
              ? Effect.void
              : Effect.fail(new NotionSyncError({ reason: 'notion-page-move-failed', cause })),
          ),
        )
        if (onEvent !== undefined) {
          onEvent(
            SyncEvent.PageOpApplied({
              id: opId,
              kind: 'movePage',
              pageId: op.pageId,
              durationMs: performance.now() - t0,
              at: Date.now(),
            }),
          )
        }
        o11y.opCount.n += 1
        pageCounts = { ...pageCounts, moves: pageCounts.moves + 1 }
      })

    // One ordered pass handles every scope, including newly created pages.
    // Flush ordinary block batches at page boundaries so a mixed sequence of
    // pages and blocks retains its sibling order and resolves parent tmp ids.
    {
      let blockBuf: DiffOp[] = []
      const flushBlocks = Effect.gen(function* () {
        if (blockBuf.length > 0) {
          const toFlush = blockBuf
          blockBuf = []
          yield* applyDiff(toFlush, idMap, checkpointAppended, o11y, priorHashById, absorbed)
        }
      })
      for (const op of executionPlan) {
        if (
          op.kind === 'append' ||
          op.kind === 'insert' ||
          op.kind === 'update' ||
          op.kind === 'remove'
        ) {
          blockBuf.push(op)
          continue
        }
        if (op.kind !== 'createPage' && op.kind !== 'movePage') continue
        yield* flushBlocks
        if (op.kind === 'createPage') yield* runCreatePage(op)
        else yield* runMovePage(op)
      }
      yield* flushBlocks
    }

    // Step 4: updatePage for retained sub-pages.
    for (const op of pageOps) {
      if (op.kind !== 'updatePage') continue
      const opId = o11y.nextOpId()
      const t0 = performance.now()
      if (onEvent !== undefined) {
        onEvent(
          SyncEvent.PageOpIssued({
            id: opId,
            kind: 'updatePage',
            pageId: op.pageId,
            at: Date.now(),
          }),
        )
      }
      yield* NotionPages.update({
        pageId: op.pageId,
        ...(op.title !== undefined ? { properties: { title: { title: op.title as never } } } : {}),
        ...(op.icon !== undefined ? { icon: op.icon as never } : {}),
        ...(op.cover !== undefined ? { cover: op.cover as never } : {}),
      }).pipe(
        Effect.mapError(
          (cause) => new NotionSyncError({ reason: 'notion-page-update-failed', cause }),
        ),
      )
      if (onEvent !== undefined) {
        onEvent(
          SyncEvent.PageOpApplied({
            id: opId,
            kind: 'updatePage',
            pageId: op.pageId,
            durationMs: performance.now() - t0,
            at: Date.now(),
          }),
        )
      }
      o11y.opCount.n += 1
      pageCounts = { ...pageCounts, updates: pageCounts.updates + 1 }
    }

    // Step 6: archivePage for sub-pages with no matching candidate.
    for (const op of pageOps) {
      if (op.kind !== 'archivePage') continue
      const opId = o11y.nextOpId()
      const t0 = performance.now()
      if (onEvent !== undefined) {
        onEvent(
          SyncEvent.PageOpIssued({
            id: opId,
            kind: 'archivePage',
            pageId: op.pageId,
            at: Date.now(),
          }),
        )
      }
      yield* NotionPages.archive({ pageId: op.pageId }).pipe(
        Effect.mapError(
          (cause) => new NotionSyncError({ reason: 'notion-page-archive-failed', cause }),
        ),
      )
      if (onEvent !== undefined) {
        onEvent(
          SyncEvent.PageOpApplied({
            id: opId,
            kind: 'archivePage',
            pageId: op.pageId,
            durationMs: performance.now() - t0,
            at: Date.now(),
          }),
        )
      }
      o11y.opCount.n += 1
      pageCounts = { ...pageCounts, archives: pageCounts.archives + 1 }
    }

    // Step 7 (phase 4d, #618): apply `reorderPages` ops via the pages.move
    // roundtrip primitive. Each op is a (parentId, [p1, p2, p3, …]) tuple; for
    // each page id in target order we `pages.move` it to a holding parent, then
    // back to `parentId`. That bumps the page to the end of `parentId`'s
    // `child_page` block list (experiment 9 in
    // `tmp/notion-618/options-ordering.md`). Iterating in target order lands
    // the full order with 2N API calls. Sequential on purpose — parallelism
    // would race the "last one wins tail append" ordering.
    //
    // Holding-parent lifecycle (per-sync ephemeral for the auto-provisioned
    // path): a scratch page is created on first demand inside this sync,
    // reused for every reorderPages op in this sync, and archived at the end.
    // Cache stashing was considered and rejected — reusing across syncs needs
    // restore-before-use + re-archive-after, which adds two API calls per
    // sync-with-reorder and complicates partial-failure semantics. Minting
    // fresh is one extra create+archive per sync-with-reorder. Caller-
    // supplied holding parents are never archived; the caller owns the
    // lifecycle.
    const reorderOps = pageOps.filter(
      (op): op is Extract<PageOp, { kind: 'reorderPages' }> => op.kind === 'reorderPages',
    )
    if (reorderOps.length > 0) {
      const callerHolding =
        typeof opts.reorderSiblings === 'object' && opts.reorderSiblings !== null
          ? opts.reorderSiblings.holdingParentId
          : undefined
      let holdingId: string | undefined = callerHolding
      for (const op of reorderOps) {
        const resolvedParent = resolve(op.parentId)
        // Auto-provision on first need. Put the holding page under the same
        // parent as the first reorder's target parent — keeps the scratch in
        // the same workspace region and avoids crossing permission boundaries.
        if (holdingId === undefined) {
          const created = yield* NotionPages.create({
            parent: { type: 'page_id', page_id: resolvedParent },
            properties: {
              title: {
                title: [
                  {
                    type: 'text',
                    text: { content: '@overeng/notion-react holding (do not touch)' },
                  },
                ],
              },
            },
          }).pipe(
            Effect.mapError(
              (cause) =>
                new NotionSyncError({ reason: 'notion-reorder-holding-create-failed', cause }),
            ),
          )
          const createdId = (created as { id?: string }).id
          if (createdId === undefined) {
            return yield* new NotionSyncError({
              reason: 'notion-reorder-holding-create-failed',
              cause: 'no id in response',
            })
          }
          holdingId = createdId
          o11y.opCount.n += 1
        }
        const opId = o11y.nextOpId()
        const t0 = performance.now()
        if (onEvent !== undefined) {
          onEvent(
            SyncEvent.PageOpIssued({
              id: opId,
              kind: 'reorderPages',
              pageId: resolvedParent,
              at: Date.now(),
            }),
          )
        }
        for (const pageId of op.orderedPageIds) {
          yield* NotionPages.move({
            pageId,
            parent: { type: 'page_id', page_id: holdingId },
          }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-page-reorder-failed', cause }),
            ),
          )
          o11y.opCount.n += 1
          yield* NotionPages.move({
            pageId,
            parent: { type: 'page_id', page_id: resolvedParent },
          }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-page-reorder-failed', cause }),
            ),
          )
          o11y.opCount.n += 1
        }
        if (onEvent !== undefined) {
          onEvent(
            SyncEvent.PageOpApplied({
              id: opId,
              kind: 'reorderPages',
              pageId: resolvedParent,
              durationMs: performance.now() - t0,
              at: Date.now(),
            }),
          )
        }
        pageCounts = { ...pageCounts, reorders: pageCounts.reorders + 1 }
      }
      // Archive the auto-provisioned holding page. Caller-supplied holding
      // parents stay where they are — callers own the lifecycle.
      if (callerHolding === undefined && holdingId !== undefined) {
        yield* NotionPages.archive({ pageId: holdingId }).pipe(
          // Best-effort: if archive fails we still succeeded on the reorder,
          // and the scratch page is recognizable by its title.
          Effect.catch(() => Effect.void),
        )
        o11y.opCount.n += 1
      }
    }

    resolveTreeIds(candidate, idMap)

    // Final authoritative snapshot. Carries the root-page metadata hashes so
    // the next sync can diff them cheaply (issue #618 phase 3b).
    const baseTree = candidateToCache(candidate, CACHE_SCHEMA_VERSION)
    const tree: CacheTree =
      rootPage !== undefined
        ? {
            ...baseTree,
            ...(rootPage.titleHash !== undefined ? { rootTitleHash: rootPage.titleHash } : {}),
            ...(rootPage.iconHash !== undefined ? { rootIconHash: rootPage.iconHash } : {}),
            ...(rootPage.coverHash !== undefined ? { rootCoverHash: rootPage.coverHash } : {}),
          }
        : baseTree
    yield* opts.cache
      .save(tree)
      .pipe(Effect.mapError((cause) => new NotionSyncError({ reason: 'cache-save-failed', cause })))

    const counts = tallyDiff(plan)
    if (onEvent !== undefined) {
      onEvent(
        SyncEvent.SyncEnd({
          pageId: opts.pageId,
          durationMs: performance.now() - syncStartMs,
          ok: true,
          opCount: o11y.opCount.n,
          ...(fallbackReason !== undefined ? { fallbackReason } : {}),
          at: Date.now(),
        }),
      )
    }
    if (opts.onMetrics !== undefined && metricsAgg !== undefined) {
      opts.onMetrics(metricsAgg.getMetrics())
    }
    const result: SyncResult = {
      appends: counts.appends,
      updates: counts.updates,
      inserts: counts.inserts,
      removes: counts.removes,
      pages: pageCounts,
    }
    return fallbackReason === undefined ? result : { ...result, fallbackReason }
  }).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        /* Fan out the failure SyncEnd to the composed `onEvent` (which
           already multiplexes user handler + metrics aggregator), then
           deliver the final `onMetrics` snapshot. ok === false is carried
           into the metrics. */
        const ev = SyncEvent.SyncEnd({
          pageId: opts.pageId,
          durationMs: performance.now() - syncStartMs,
          ok: false,
          opCount: o11y.opCount.n,
          at: Date.now(),
        })
        onEvent?.(ev)
        if (opts.onMetrics !== undefined && metricsAgg !== undefined) {
          opts.onMetrics(metricsAgg.getMetrics())
        }
      }),
    ),
  )
}

/**
 * How `plan()` treats potential cache staleness.
 *
 * `'live'` (default): mirror `sync()`'s pre-flight exactly — resolve pending
 * inline markers (in memory; nothing is persisted) and fetch the page's live
 * recursive identity tree for drift detection. The returned plan is what
 * `sync()` would compute if invoked now, at the cost of read-only API calls.
 * There is still no lock: a writer racing between `plan()` and a later
 * `sync()` can invalidate the plan (sync re-computes, so it stays correct —
 * the *plan* is what goes stale, never the applied result).
 *
 * `'cache-only'`: a pure function of cache + JSX — zero API calls. Cannot see
 * out-of-band drift or resolve pending markers, so it diverges from `sync()`
 * whenever the server moved out from under the cache (including the
 * cold-`'clean'` baseline sweep, which needs the live child list to plan its
 * removes). Use for offline "would anything change?" checks against a cache
 * that is trusted to be fresh.
 */
export type PlanStaleness = 'live' | 'cache-only'

/**
 * Read-only sync plan. `ops` mirrors `sync()`'s pre-flight diff one-to-one
 * (including the root-page `updatePage` when root metadata drifted) but is
 * in DIFF-EMISSION order, not `sync()`'s phased application schedule — the
 * driver applies retained-sub-page-scoped block ops before retained-page
 * `updatePage`s. Treat `ops` as an operation set with per-scope order, not
 * an execution trace; the tallies mirror `SyncResult`'s counters for the
 * same element/cache state.
 */
export interface SyncPlan {
  readonly ops: readonly DiffOp[]
  readonly blocks: {
    readonly appends: number
    readonly updates: number
    readonly inserts: number
    readonly removes: number
  }
  readonly pages: {
    readonly creates: number
    readonly updates: number
    readonly archives: number
    readonly moves: number
    readonly reorders: number
  }
  readonly fallbackReason: SyncFallbackReason | undefined
  /** `true` iff the page is already at the fixpoint: a sync now would write nothing. */
  readonly empty: boolean
  /**
   * Present iff `pageLifecycle: 'append-only'` was passed (#1124): the ops
   * a sync under that mode would reject — same predicate, so `plan()` is a
   * free preview: an empty array proves the sync would not trip the
   * lifecycle guard for this observed state. `plan()` itself never fails on
   * violations.
   */
  readonly lifecycleViolations?: readonly DiffOp[]
}

/**
 * Read-only companion to {@link sync}: compute the plan `sync()` would apply
 * for `element` against the current cache WITHOUT performing any write — no
 * Notion mutation, no cache save. Composed from the same building blocks as
 * `sync()`'s own pre-flight (`identityTreeDrifted`, `selectDiffBase`, `diff`,
 * `rootPageUpdateOpFor`), so the two cannot
 * disagree about what a sync would do for a given observed state.
 *
 * The `empty` flag doubles as a post-publication fixpoint oracle: after a
 * successful, CONVERGENT `sync()`, `plan()` over the same element returns
 * zero ops. One documented exception: under the default
 * `reorderSiblings: false`, a JSX reshuffle of retained `<ChildPage>`
 * siblings emits a same-parent `movePage` that Notion rejects and `sync()`
 * deliberately swallows (a documented no-op — see `reorderSiblings`), so
 * server sibling order never converges and every subsequent live `plan()`
 * keeps reporting that move. Opt into `reorderSiblings: true` (or accept
 * the drift) for a true fixpoint.
 *
 * `onEvent` mirrors `sync()`'s hook for the read-only prefix: the `'live'`
 * children GET emits `OpIssued`/`OpSucceeded`/`OpFailed` with kind
 * `'retrieve'` (it is real HTTP volume), and the computed plan emits one
 * `PlanComputed`. No other events — in particular no `SyncStart`/`SyncEnd`
 * (nothing is synced) and no `CacheOutcome` (so plan probes don't skew
 * cache-efficiency metrics aggregated across real syncs).
 */
export const planWithClient = (
  element: ReactNode,
  opts: {
    readonly pageId: string
    readonly cache: NotionCache
    readonly coldBaseline?: ColdBaseline
    readonly reorderSiblings?: boolean | { readonly holdingParentId: string }
    readonly staleness?: PlanStaleness
    readonly onEvent?: SyncEventHandler
    /**
     * See {@link sync}'s `pageLifecycle`. Under `'append-only'`, `plan()`
     * reports the offending ops in `SyncPlan.lifecycleViolations` WITHOUT
     * failing — a free preview of what the sync-side guard would reject.
     */
    readonly pageLifecycle?: PageLifecycle
  },
): Effect.Effect<SyncPlan, NotionSyncError, NotionRendererClient> =>
  Effect.gen(function* () {
    const staleness: PlanStaleness = opts.staleness ?? 'live'
    const onEvent = opts.onEvent
    let retrieveOpId = 0
    const retrieveO11y: RetrieveO11yCtx = {
      onEvent,
      nextOpId: () => {
        retrieveOpId += 1
        return retrieveOpId
      },
      opCount: { n: 0 },
    }
    const coldBaseline: ColdBaseline = opts.coldBaseline ?? 'clean'
    let prior = yield* opts.cache.load.pipe(
      Effect.mapError((cause) => new NotionSyncError({ reason: 'cache-load-failed', cause })),
    )
    const candidate = buildCandidateTree(element, opts.pageId)
    if (
      staleness === 'live' &&
      prior !== undefined &&
      prior.rootId === opts.pageId &&
      prior.schemaVersion === CACHE_SCHEMA_VERSION
    ) {
      const resolved = yield* resolvePendingChildren(prior.children)
      if (resolved.changed) prior = { ...prior, children: resolved.nodes }
    }

    const schemaMismatch = prior !== undefined && prior.schemaVersion !== CACHE_SCHEMA_VERSION
    const pageIdDrift = prior !== undefined && prior.rootId !== opts.pageId
    const useColdPath = prior === undefined || pageIdDrift

    let drifted = false
    let liveIdentities: readonly LiveIdentityNode[] = []
    const wantsLiveRetrieve =
      staleness === 'live' &&
      ((prior !== undefined && !schemaMismatch && !pageIdDrift) ||
        (useColdPath && coldBaseline === 'clean'))
    if (wantsLiveRetrieve) {
      const recursive = prior !== undefined && !schemaMismatch && !pageIdDrift
      const holdingParentId =
        typeof opts.reorderSiblings === 'object' ? opts.reorderSiblings.holdingParentId : undefined
      liveIdentities = yield* retrieveLiveIdentities(
        opts.pageId,
        recursive,
        retrieveO11y,
        false,
        holdingParentId,
      )
      if (prior !== undefined && !schemaMismatch && !pageIdDrift) {
        drifted = identityTreeDrifted(prior.children, liveIdentities)
      }
    }

    const { diffBase, fallbackReason } = selectDiffBase({
      pageId: opts.pageId,
      prior,
      schemaMismatch,
      pageIdDrift,
      coldBaseline,
      drifted,
      liveIdentities,
    })

    const rootUpdateOp = rootPageUpdateOpFor({ candidate, prior, pageId: opts.pageId })
    const ops: DiffOp[] = [
      ...(rootUpdateOp !== undefined ? [rootUpdateOp] : []),
      ...diff(diffBase, candidate, {
        reorderSiblings: opts.reorderSiblings !== undefined && opts.reorderSiblings !== false,
      }),
    ]
    const blocks = tallyDiff(ops)
    if (onEvent !== undefined) {
      onEvent(
        SyncEvent.PlanComputed({
          pageId: opts.pageId,
          appends: blocks.appends,
          inserts: blocks.inserts,
          updates: blocks.updates,
          removes: blocks.removes,
          at: Date.now(),
        }),
      )
    }
    return {
      ops,
      blocks,
      pages: tallyPageOps(ops),
      fallbackReason,
      empty: ops.length === 0,
      // Same predicate as sync()'s enforcement point, so the preview and the
      // guard cannot disagree for a given observed state (#1124).
      ...(opts.pageLifecycle === 'append-only'
        ? { lifecycleViolations: pageLifecycleViolations({ ops, candidate }) }
        : {}),
    }
  })

/** Default token route. Use syncWithClient with NotionRendererClient for injected I/O. */
export const sync = (element: ReactNode, opts: Parameters<typeof syncWithClient>[1]) =>
  syncWithClient(element, opts).pipe(Effect.provide(NotionRendererClientLive))

/** Default token route for read-only planning. */
export const plan = (element: ReactNode, opts: Parameters<typeof planWithClient>[1]) =>
  planWithClient(element, opts).pipe(Effect.provide(NotionRendererClientLive))
