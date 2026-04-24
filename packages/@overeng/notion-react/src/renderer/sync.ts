import type { HttpClient } from '@effect/platform'
import { Chunk, Effect, Stream } from 'effect'
import type { ReactNode } from 'react'

import {
  NotionApiError,
  NotionBlocks,
  NotionPages,
  type NotionConfig,
} from '@overeng/notion-effect-client'

import type { CacheNode, CacheTree, NotionCache } from '../cache/types.ts'
import { CACHE_SCHEMA_VERSION } from '../cache/types.ts'
import { NotionSyncError } from './errors.ts'
import type { PageOp } from './op-buffer.ts'
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
  if (afterId === '') {
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
  ) => Effect.Effect<void, NotionSyncError, NotionConfig | HttpClient.HttpClient>,
  o11y: O11yCtx,
): Effect.Effect<void, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
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
        Effect.catchAll((cause) =>
          Effect.gen(function* () {
            if (!isUploadIdRejection(cause) || o11y.onUploadIdRejected === undefined) {
              return yield* Effect.fail(cause)
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
            if (refreshed === undefined) return yield* Effect.fail(cause)
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
 * This pass folds every descendant `append` op of an atomic container into
 * the container op's `props.children` as a nested Notion block-body array.
 * The absorbed ops are removed from the resulting plan. After the atomic
 * op's API call succeeds, the caller issues a recursive children retrieval
 * to map absorbed tmpIds → server-minted ids.
 *
 * Only newly-created subtrees are folded (append ops reachable through the
 * tmpId graph). Inserts anchored on existing blocks carry server ids and
 * are treated as independent API calls. Updates and removes are left
 * untouched.
 */
interface AbsorbedSubtree {
  /** The atomic container op whose body now carries the nested payload. */
  readonly containerTmpId: string
  /**
   * Absorbed descendants in the exact order they appear under the container,
   * depth-first, matching the shape of `props.children` shipped to Notion.
   * Used to map nested tmpIds → server ids after the atomic append returns.
   */
  readonly descendants: readonly { readonly tmpId: string; readonly depth: number }[]
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
   * Build the nested Notion API body for `op`, recursively folding
   * descendants. Children are capped at `MAX_CHILDREN_PER_APPEND` per
   * level (Notion's validation limit on `table.children` and every other
   * nested `children` array). Overflow at the top-level atomic container
   * is left in the plan as plain append ops — they get batched normally
   * against the container's server id once it's resolved via `idMap`. At
   * deeper levels (e.g. a `column` with >100 direct children inside a
   * column_list), we surface loudly: that shape is rare and would require
   * per-level chunking logic not implemented here.
   */
  const buildNestedBody = (
    op: AppendLike,
    descendants: { tmpId: string; depth: number }[],
    depth: number,
    isTopLevelContainer: boolean,
  ): Record<string, unknown> => {
    const kids = childrenByParent.get(op.tmpId) ?? []
    const payload: Record<string, unknown> = { ...op.props }
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
        descendants.push({ tmpId: k.tmpId, depth })
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
      const descendants: { tmpId: string; depth: number }[] = []
      const foldedProps = buildNestedBody(op, descendants, 1, true)
      absorbed.set(op.tmpId, { containerTmpId: op.tmpId, descendants })
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
 * Resolve tmpIds of an atomic container's absorbed descendants by walking
 * the container's live child tree on Notion. Traversal order mirrors
 * `buildNestedBody`: depth-first, children in submission order. Mutates
 * `idMap` in place.
 */
const resolveAbsorbedTmpIds = (
  containerServerId: string,
  descendants: readonly { readonly tmpId: string; readonly depth: number }[],
  idMap: Map<string, string>,
): Effect.Effect<void, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (descendants.length === 0) return
    // Retrieve the full subtree by DFS. Order: for each child of a given
    // parent, consume descendants[cursor] (which corresponds to that child
    // at the current depth), advance, then recurse into its children.
    let cursor = 0
    const walk = (
      parentId: string,
      depth: number,
    ): Effect.Effect<void, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
      Effect.gen(function* () {
        const live = yield* Stream.runCollect(
          NotionBlocks.retrieveChildrenStream({ blockId: parentId }),
        ).pipe(
          Effect.mapError(
            (cause) => new NotionSyncError({ reason: 'notion-retrieve-failed', cause }),
          ),
        )
        for (const child of Chunk.toReadonlyArray(live)) {
          if (cursor >= descendants.length) return
          const expected = descendants[cursor]!
          if (expected.depth !== depth) return
          idMap.set(expected.tmpId, child.id)
          cursor += 1
          // Recurse if there's a following descendant at greater depth —
          // means this node has absorbed grandchildren.
          const next = descendants[cursor]
          if (next !== undefined && next.depth > depth) {
            yield* walk(child.id, depth + 1)
          }
        }
      })
    yield* walk(containerServerId, 1)
  })

/**
 * Convert a candidate subtree packed inline into a `pages.create` body into
 * the `children` field payload. For phase 3b every inline body is already
 * pre-shaped by `inlinePackChildren`, so this is effectively a pass-through.
 * Kept as a named helper so the sync driver's read path is easier to trace.
 */
const toCreateChildren = (inline: readonly unknown[]): readonly Record<string, unknown>[] =>
  inline as readonly Record<string, unknown>[]

/**
 * After a successful `pages.create` with inline children, walk the server's
 * returned tree to map the placeholder tmpIds we assigned to each inline
 * block body onto the real Notion block ids. Used so that subsequent
 * scope-tagged block ops (tail from `inlinePackChildren`) can resolve their
 * parents through `idMap`.
 */
const resolveInlineChildrenIds = (
  createdPageId: string,
  candidate: PageOp & { readonly kind: 'createPage' },
  cands: readonly CandidateNode[],
  idMap: Map<string, string>,
): Effect.Effect<void, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    // Resolve the newly-created page's tmp id.
    idMap.set(candidate.tmpPageId, createdPageId)
    if (cands.length === 0) return
    // Walk server-side children of the created page depth-first. For each
    // candidate that was shipped inline (blockId is a `tmp-*` placeholder),
    // pair it with the corresponding live child and recurse.
    const walk = (
      parentId: string,
      nodes: readonly CandidateNode[],
    ): Effect.Effect<void, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
      Effect.gen(function* () {
        const live = yield* Stream.runCollect(
          NotionBlocks.retrieveChildrenStream({ blockId: parentId }),
        ).pipe(
          Effect.mapError(
            (cause) => new NotionSyncError({ reason: 'notion-retrieve-failed', cause }),
          ),
        )
        const liveArr = Chunk.toReadonlyArray(live)
        // `nodes` can mix block candidates (which were inlined into the
        // pages.create body and therefore appear in `liveArr`) with page
        // candidates (tailed out as follow-up createPage ops and NOT present
        // here). Advance the live-child cursor only for block candidates so
        // alignment doesn't shift when a page sibling appears before an inline
        // block. See PR #623 review: "Skip page nodes without advancing
        // live-child alignment".
        let liveIdx = 0
        for (let i = 0; i < nodes.length; i++) {
          const cand = nodes[i]!
          if (cand.nodeKind === 'page') continue
          if (liveIdx >= liveArr.length) break
          const server = liveArr[liveIdx]!
          liveIdx++
          if (cand.blockId !== undefined && cand.blockId.startsWith('tmp-')) {
            idMap.set(cand.blockId, server.id)
          }
          // Walk inline children (depth 2 only — deeper children were tailed
          // as regular block ops and are resolved by the standard flush path).
          if (cand.children.length > 0) {
            const hasInline = cand.children.some(
              (c) => c.nodeKind !== 'page' && c.blockId?.startsWith('tmp-') === true,
            )
            if (hasInline) yield* walk(server.id, cand.children)
          }
        }
      })
    yield* walk(createdPageId, cands)
  })

const applyDiff = (
  rawOps: readonly DiffOp[],
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
): Effect.Effect<void, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const resolve = (id: string): string => idMap.get(id) ?? id
    const { plan: ops, absorbed } = foldAtomicContainers(rawOps)
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
              // Resolve absorbed descendant tmpIds for any atomic containers
              // in the committed batch. Must run before the checkpoint so the
              // working cache sees the same idMap the candidate tree is about
              // to be rewritten with (resolveTreeIds in sync()).
              for (const c of committed) {
                const sub = absorbed.get(c.op.tmpId)
                if (sub !== undefined) {
                  yield* resolveAbsorbedTmpIds(c.serverId, sub.descendants, idMap)
                }
              }
              yield* checkpoint({ kind: 'appended', committed })
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
            Effect.catchAll((cause) =>
              Effect.gen(function* () {
                if (!isUploadIdRejection(cause) || o11y.onUploadIdRejected === undefined) {
                  return yield* Effect.fail(cause)
                }
                const refreshed = yield* refreshBatchUploadIds(
                  [{ props: updateProps, blockId: op.blockId, tmpId: undefined }],
                  o11y.onUploadIdRejected,
                  cause,
                  o11y,
                )
                if (refreshed === undefined) return yield* Effect.fail(cause)
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
            Effect.catchAll((cause) =>
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

/**
 * Build a cache-shaped base from the live top-level block ids on drift.
 *
 * When a prior cache is available, this preserves entries whose blockIds are
 * still live — their meaningful key/hash/children let `diff()` retain them
 * against matching candidate keys. Live blockIds that are NOT in the prior
 * cache get synthetic `drift:<blockId>` keys so `diff()` emits a `remove` for
 * each (they're unowned leftovers).
 *
 * Without a prior (cold-clean path), every live id becomes a ghost entry so
 * every live top-level block converts into an idempotent remove.
 *
 * Why this matters: the naive "all-ghost" base turns a 1-block out-of-band
 * drift into a full page rebuild — N removes + N appends — which is O(minutes)
 * on 500+ block pages. The hybrid base preserves locality: only the actual
 * drift (blocks added/removed out-of-band) drives ops; the stable majority is
 * retained via the normal LCS path.
 */
const driftedBase = (
  rootId: string,
  liveIds: readonly string[],
  prior: CacheTree | undefined,
): CacheTree => {
  const priorByBlockId = new Map<string, CacheNode>()
  if (prior !== undefined) {
    for (const c of prior.children) priorByBlockId.set(c.blockId, c)
  }
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    rootId,
    children: liveIds.map((blockId) => {
      const priorNode = priorByBlockId.get(blockId)
      if (priorNode !== undefined) return priorNode
      return {
        key: `drift:${blockId}`,
        blockId,
        type: 'unknown',
        hash: '',
        children: [],
        nodeKind: 'block',
      }
    }),
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

export const sync = (
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
  },
): Effect.Effect<SyncResult, NotionSyncError, NotionConfig | HttpClient.HttpClient> => {
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
    const prior = yield* opts.cache.load.pipe(
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

    // Pre-flight drift detection (#105). When we have a usable prior cache,
    // fetch the page's current top-level children and compare against the
    // cache's expected block-id set. Any divergence (block archived out of
    // band, added by another client, cache bitrot) means the diff would
    // target stale ids — patching ghosts and leaving live content orphaned.
    // Treat drift as a cold start: rebuild from scratch so server state
    // converges on the rendered tree.
    //
    // Cost: one GET per sync in the hot-cache path. Kept shallow — nested
    // children are verified lazily through the checkpoint round-trip since
    // every mutation resolves to a real server id.
    // Pre-computed so the retrieve decision below can see it. `useCold` also
    // covers `schemaMismatch` implicitly — we diff against the stale tree in
    // that case, so the cold-baseline sweep doesn't apply there (see below).
    const useColdPath = prior === undefined || pageIdDrift

    let drifted = false
    let liveTopLevelIds: readonly string[] = []
    // Retrieve live top-level ids when either (a) we have a warm cache and
    // want drift detection, or (b) we're taking the cold path with
    // `coldBaseline === 'clean'` and need the live ids to synthesize a
    // drift-style base so every leftover block converts into an idempotent
    // remove (Fix B — pixeltrail dogfood v5).
    const wantsLiveRetrieve =
      (prior !== undefined && !schemaMismatch && !pageIdDrift) ||
      (useColdPath && coldBaseline === 'clean')
    if (wantsLiveRetrieve) {
      const retrieveOpId = o11y.nextOpId()
      const t0 = onEvent !== undefined ? performance.now() : 0
      if (onEvent !== undefined) {
        onEvent(SyncEvent.OpIssued({ id: retrieveOpId, kind: 'retrieve', at: Date.now() }))
      }
      const liveChildren = yield* Stream.runCollect(
        NotionBlocks.retrieveChildrenStream({ blockId: opts.pageId }),
      ).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            if (onEvent !== undefined) {
              onEvent(
                SyncEvent.OpFailed({
                  id: retrieveOpId,
                  kind: 'retrieve',
                  durationMs: performance.now() - t0,
                  error: String(cause),
                  at: Date.now(),
                }),
              )
            }
          }),
        ),
        Effect.mapError(
          (cause) => new NotionSyncError({ reason: 'notion-retrieve-failed', cause }),
        ),
      )
      o11y.opCount.n += 1
      if (onEvent !== undefined) {
        onEvent(
          SyncEvent.OpSucceeded({
            id: retrieveOpId,
            kind: 'retrieve',
            durationMs: performance.now() - t0,
            resultCount: Chunk.size(liveChildren),
            at: Date.now(),
          }),
        )
      }
      const liveIds: string[] = []
      for (const b of Chunk.toReadonlyArray(liveChildren)) {
        if (b.in_trash !== true) liveIds.push(b.id)
      }
      liveTopLevelIds = liveIds
      // Drift detection only applies to the warm-cache path; the cold path
      // always cleans pre-existing children when `coldBaseline === 'clean'`.
      if (prior !== undefined && !schemaMismatch && !pageIdDrift) {
        const expectedIds = prior.children.map((c) => c.blockId)
        // Ordered sequence equality — out-of-band reorders leave the block-id
        // set intact but scramble order, and we must rebuild to converge.
        if (liveIds.length !== expectedIds.length) {
          drifted = true
        } else {
          for (let k = 0; k < expectedIds.length; k++) {
            if (liveIds[k] !== expectedIds[k]) {
              drifted = true
              break
            }
          }
        }
      }
    }

    // Cold start when either there's no prior cache or the prior cache is
    // for a different page (pageIdDrift). On `drifted` we keep a synthesized
    // base built from the *actual* live top-level ids so the diff emits
    // removes for the orphaned blocks and appends for the candidate tree —
    // otherwise a drifted page would get duplicated content (old blocks
    // remain, new copies append) and never converge.
    const useCold = useColdPath
    // `diffBase` feeds the diff algorithm; on drift (or cold-clean with
    // pre-existing live blocks) it carries synthetic `drift:*` ghost entries
    // so every live top-level block becomes a remove op. `workingBase` seeds
    // the in-memory working cache that is checkpointed to disk — it must
    // NEVER contain ghost entries, or a mid-sync failure will leak them
    // into the persisted cache and poison the next warm sync (dogfood v4:
    // ghosts drove 111 deletes against already-archived blocks). For
    // drift / cold-clean, start the working cache empty: ops confirmed
    // against Notion populate it via `workingAppend`; pending removes
    // target ghost blockIds that are absent from `working.byId`, which is
    // a safe no-op.
    const coldClean = useCold && coldBaseline === 'clean' && liveTopLevelIds.length > 0
    const diffBase: CacheTree = useCold
      ? coldClean
        ? driftedBase(opts.pageId, liveTopLevelIds, undefined)
        : emptyCache(opts.pageId)
      : drifted
        ? driftedBase(opts.pageId, liveTopLevelIds, prior)
        : prior
    /* Working base mirrors diffBase for warm drift (no ghost leakage risk —
       we only copy prior entries whose blockIds are still live server-side,
       so they're real confirmed entries). For cold paths we stay empty. */
    const workingBase: CacheTree = useCold
      ? emptyCache(opts.pageId)
      : drifted
        ? {
            schemaVersion: CACHE_SCHEMA_VERSION,
            rootId: opts.pageId,
            children: diffBase.children.filter((c) => !c.key.startsWith('drift:')),
          }
        : prior
    const fallbackReason: SyncFallbackReason | undefined = pageIdDrift
      ? 'page-id-drift'
      : drifted
        ? 'cache-drift'
        : prior === undefined
          ? 'cold-cache'
          : schemaMismatch
            ? 'schema-mismatch'
            : undefined

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

    // Phase 3b (#618): partition the plan. Block ops flow through applyDiff;
    // page ops route to pages.* and are executed in a fixed order so the
    // block ops we're emitting always target the correct parent page id.
    const blockPlan: DiffOp[] = []
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
      } else {
        blockPlan.push(op)
      }
    }

    // Partition block ops by scope. Root-scope ops (scopePageId undefined) are
    // picked up by the candidate-ordered interleaved pass below; tail block
    // ops scoped to a createPage's tmpPageId run inside `runCreatePage`;
    // retained-sub-page-scoped ops run in step 2b.
    const pageScopedBlockPlan = new Map<string, DiffOp[]>()
    for (const op of blockPlan) {
      const scope =
        op.kind === 'append' || op.kind === 'insert' || op.kind === 'update' || op.kind === 'remove'
          ? op.scopePageId
          : undefined
      if (scope !== undefined) {
        const list = pageScopedBlockPlan.get(scope) ?? []
        list.push(op)
        pageScopedBlockPlan.set(scope, list)
      }
    }

    // Root-page metadata update (candidate <Page> vs prior cache root hashes).
    // Emits a single `pages.update` when any of title/icon/cover drifted.
    let pageCounts: PageOpCounts = emptyPageCounts()
    let partialCreateFallback = false
    const rootPage = candidate.rootPage
    if (rootPage !== undefined) {
      const priorT = prior?.rootTitleHash
      const priorI = prior?.rootIconHash
      const priorC = prior?.rootCoverHash
      const titleDrift = rootPage.titleHash !== undefined && rootPage.titleHash !== priorT
      // Phase 4b (#618): `null` sentinel on fresh root (no prior icon) is a
      // no-op; the candidate null hash matches "unset" server state. Once a
      // prior hash exists, candidate `null` drifts and emits `icon: null`.
      const iconDrift = iconOrCoverDrift(rootPage.iconHash, priorI)
      const coverDrift = iconOrCoverDrift(rootPage.coverHash, priorC)
      if (titleDrift || iconDrift || coverDrift) {
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
          ...(titleDrift ? { properties: { title: { title: rootPage.title as never } } } : {}),
          ...(iconDrift ? { icon: rootPage.icon as never } : {}),
          ...(coverDrift ? { cover: rootPage.cover as never } : {}),
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
    }

    // Issue #618 follow-up: at the root scope, `pages.create` and block
    // `append` both tail-append on the server. Running block ops before
    // createPage (as the pre-fix code did) inverted sibling order on the
    // server whenever a JSX tree placed a `<ChildPage>` before a sibling
    // block — the next warm sync would then hit a drift mismatch (cache in
    // candidate order, server in swapped order) and treat the retained
    // `<ChildPage>` as unretained, blowing up `candidateToCache` with an
    // unresolved tmpId for its inner block descendants.
    //
    // Fix: walk the root-scope plan in candidate order, interleaving block
    // ops with `createPage` / `movePage`. Consecutive block ops are still
    // batched through `applyDiff` so per-parent coalescing (#101) stays
    // intact. Same-scope `movePage` is also interleaved because Notion
    // tail-appends the moved page at its new parent.
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
          ...(op.inlineChildren.length > 0
            ? { children: toCreateChildren(op.inlineChildren) }
            : {}),
        }).pipe(
          Effect.mapError(
            (cause) => new NotionSyncError({ reason: 'notion-page-create-failed', cause }),
          ),
        )
        const createdId = (created as { id?: string }).id
        if (createdId === undefined) {
          return yield* Effect.fail(
            new NotionSyncError({
              reason: 'notion-page-create-failed',
              cause: 'no id in response',
            }),
          )
        }
        idMap.set(op.tmpPageId, createdId)
        const inlineCands = (op.inlineCandidates ?? []) as readonly CandidateNode[]
        yield* resolveInlineChildrenIds(createdId, op, inlineCands, idMap)

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

        const tail = pageScopedBlockPlan.get(op.tmpPageId) ?? []
        if (tail.length > 0) {
          yield* applyDiff(tail, idMap, checkpointAppended, o11y, priorHashById).pipe(
            Effect.catchAll((cause) =>
              Effect.gen(function* () {
                partialCreateFallback = true
                yield* NotionPages.update({ pageId: createdId, in_trash: true }).pipe(
                  Effect.catchAll(() => Effect.void),
                )
                return yield* Effect.fail(cause)
              }),
            ),
            Effect.asVoid,
          )
        }
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
          Effect.catchAll((cause) =>
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

    // Build a root-scope op list in candidate order: root block ops (no
    // scopePageId) plus `createPage`/`movePage` whose parent is the sync root.
    // `updatePage` and `archivePage` don't affect server sibling order so
    // they stay in their own steps below.
    const moveRan = new Set<string>()
    const createRan = new Set<string>()
    const rootInterleaved: DiffOp[] = []
    for (const op of plan) {
      if (
        op.kind === 'append' ||
        op.kind === 'insert' ||
        op.kind === 'update' ||
        op.kind === 'remove'
      ) {
        if (op.scopePageId === undefined) rootInterleaved.push(op)
        continue
      }
      if (op.kind === 'createPage' && op.parent.pageId === opts.pageId) {
        rootInterleaved.push(op)
        continue
      }
      if (op.kind === 'movePage' && op.parent.pageId === opts.pageId) {
        rootInterleaved.push(op)
        continue
      }
    }

    // Walk in order, batching consecutive block ops through applyDiff so
    // coalescing still holds; flush on each pageOp boundary.
    {
      let blockBuf: DiffOp[] = []
      const flushBlocks = Effect.gen(function* () {
        if (blockBuf.length > 0) {
          const toFlush = blockBuf
          blockBuf = []
          yield* applyDiff(toFlush, idMap, checkpointAppended, o11y, priorHashById)
        }
      })
      for (const op of rootInterleaved) {
        if (
          op.kind === 'append' ||
          op.kind === 'insert' ||
          op.kind === 'update' ||
          op.kind === 'remove'
        ) {
          blockBuf.push(op)
          continue
        }
        yield* flushBlocks
        if (op.kind === 'createPage') {
          yield* runCreatePage(op)
          createRan.add(op.tmpPageId)
        } else if (op.kind === 'movePage') {
          yield* runMovePage(op)
          moveRan.add(op.pageId)
        }
      }
      yield* flushBlocks
    }

    // Step 2b (phase 3c): retained-sub-page-scoped ops. These address real
    // server page ids (not tmpPageIds) — the diff's retained-page branch
    // recursed into the sub-page's children and tagged every emitted block op
    // with `scopePageId = priorSubPageBlockId`. For the same reason the root
    // scope interleaves block ops with createPage/movePage (both tail-append,
    // so running appends before nested creates inverts candidate order), every
    // sub-page scope needs the same interleaved walk. Without it, a retained
    // `<ChildPage>` with mixed `[<ChildPage>, <Paragraph>]` candidates would
    // materialize as `[Paragraph, child_page]` on the server and drift on the
    // next warm sync.
    const createPageTmpIds = new Set(
      pageOps.flatMap((op) => (op.kind === 'createPage' ? [op.tmpPageId] : [])),
    )
    const subPageScopes = new Set<string>()
    for (const scope of pageScopedBlockPlan.keys()) {
      if (createPageTmpIds.has(scope)) continue // tail block ops for a root-scope createPage already applied inside runCreatePage
      subPageScopes.add(scope)
    }
    for (const op of pageOps) {
      if (op.kind === 'createPage' && op.parent.pageId !== opts.pageId) {
        subPageScopes.add(op.parent.pageId)
      } else if (op.kind === 'movePage' && op.parent.pageId !== opts.pageId) {
        subPageScopes.add(op.parent.pageId)
      }
    }
    for (const scope of subPageScopes) {
      const scopedInterleaved: DiffOp[] = []
      for (const op of plan) {
        if (
          op.kind === 'append' ||
          op.kind === 'insert' ||
          op.kind === 'update' ||
          op.kind === 'remove'
        ) {
          if (op.scopePageId === scope) scopedInterleaved.push(op)
          continue
        }
        if (op.kind === 'createPage' && op.parent.pageId === scope) {
          scopedInterleaved.push(op)
          continue
        }
        if (op.kind === 'movePage' && op.parent.pageId === scope) {
          scopedInterleaved.push(op)
          continue
        }
      }
      let scopeBuf: DiffOp[] = []
      const flushScopeBuf = Effect.gen(function* () {
        if (scopeBuf.length > 0) {
          const toFlush = scopeBuf
          scopeBuf = []
          yield* applyDiff(toFlush, idMap, checkpointAppended, o11y, priorHashById)
        }
      })
      for (const op of scopedInterleaved) {
        if (
          op.kind === 'append' ||
          op.kind === 'insert' ||
          op.kind === 'update' ||
          op.kind === 'remove'
        ) {
          scopeBuf.push(op)
          continue
        }
        yield* flushScopeBuf
        if (op.kind === 'createPage') {
          yield* runCreatePage(op)
          createRan.add(op.tmpPageId)
        } else if (op.kind === 'movePage') {
          yield* runMovePage(op)
          moveRan.add(op.pageId)
        }
      }
      yield* flushScopeBuf
    }

    // Safety net: any createPage not yet executed (e.g. nested under a
    // createPage that itself runs via this pass — tail block ops handle that,
    // but a nested page under a nested page isn't covered above). Execute in
    // plan order so JSX order is preserved (T08: pages.create is sequential
    // because parallel creates under a common parent yield nondeterministic
    // child_page ordering).
    for (const op of pageOps) {
      if (op.kind !== 'createPage') continue
      if (createRan.has(op.tmpPageId)) continue
      yield* runCreatePage(op)
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

    // Step 5: movePage for reparented sub-pages not yet executed (those that
    // weren't at the root scope). Root-scope moves already ran in the
    // interleaved pass above to preserve sibling ordering on the server.
    for (const op of pageOps) {
      if (op.kind !== 'movePage') continue
      if (moveRan.has(op.pageId)) continue
      yield* runMovePage(op)
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
            return yield* Effect.fail(
              new NotionSyncError({
                reason: 'notion-reorder-holding-create-failed',
                cause: 'no id in response',
              }),
            )
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
          Effect.catchAll(() => Effect.void),
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
    const effectiveFallback: SyncFallbackReason | undefined = partialCreateFallback
      ? 'partial-page-create'
      : fallbackReason
    if (onEvent !== undefined) {
      onEvent(
        SyncEvent.SyncEnd({
          pageId: opts.pageId,
          durationMs: performance.now() - syncStartMs,
          ok: true,
          opCount: o11y.opCount.n,
          ...(effectiveFallback !== undefined ? { fallbackReason: effectiveFallback } : {}),
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
    return effectiveFallback === undefined
      ? result
      : { ...result, fallbackReason: effectiveFallback }
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
