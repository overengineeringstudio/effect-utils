import type { HttpClient } from '@effect/platform'
import { Chunk, Effect, Stream } from 'effect'
import type { ReactNode } from 'react'

import { NotionBlocks, type NotionConfig } from '@overeng/notion-effect-client'

import type { CacheNode, CacheTree, NotionCache } from '../cache/types.ts'
import { CACHE_SCHEMA_VERSION } from '../cache/types.ts'
import { NotionSyncError } from './errors.ts'
import type { SyncFallbackReason, SyncResult } from './render-to-notion.ts'
import {
  buildCandidateTree,
  candidateToCache,
  diff,
  tallyDiff,
  type CandidateNode,
  type CandidateTree,
  type DiffOp,
} from './sync-diff.ts'

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
})

const workingToCacheNode = (n: WorkingNode): CacheNode => ({
  key: n.key,
  blockId: n.blockId,
  type: n.type,
  hash: n.hash,
  children: n.children.map(workingToCacheNode),
})

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
  w.byId.set(node.blockId, node)
  // Register the new node's own (empty) children bucket so descendant
  // appends can find it.
  if (!w.childrenById.has(node.blockId)) w.childrenById.set(node.blockId, node.children)
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
 */
export const APPEND_CHILDREN_MAX = 100

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
const flushAppendRun = (
  run: readonly AppendLike[],
  idMap: Map<string, string>,
  resolve: (id: string) => string,
  onBatch: (
    committed: readonly { op: AppendLike; serverId: string; afterId: string | undefined }[],
  ) => Effect.Effect<void, NotionSyncError>,
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
      const children = batch.map((op) => appendBody(op.type, op.props))
      const res = yield* NotionBlocks.append({
        blockId: parentId,
        children,
        ...(position !== undefined ? { position } : {}),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new NotionSyncError({
              reason: first.kind === 'insert' ? 'notion-insert-failed' : 'notion-append-failed',
              cause,
            }),
        ),
      )
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
): Effect.Effect<void, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const resolve = (id: string): string => idMap.get(id) ?? id
    let i = 0
    while (i < ops.length) {
      const op = ops[i]!
      if (isAppendLike(op)) {
        // Coalesce consecutive append/insert ops with the same parent
        // (comparing unresolved parent ids — tmp or real — since the
        // resolution is stable within a diff plan).
        const runStart = i
        const runParent = op.parent
        while (i < ops.length) {
          const next = ops[i]!
          if (!isAppendLike(next) || next.parent !== runParent) break
          i += 1
        }
        yield* flushAppendRun(ops.slice(runStart, i) as AppendLike[], idMap, resolve, (committed) =>
          checkpoint({ kind: 'appended', committed }),
        )
        continue
      }
      switch (op.kind) {
        case 'update': {
          yield* NotionBlocks.update({ blockId: op.blockId, [op.type]: op.props }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-update-failed', cause }),
            ),
          )
          yield* checkpoint({ kind: 'updated', op })
          break
        }
        case 'remove': {
          yield* NotionBlocks.delete({ blockId: op.blockId }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-delete-failed', cause }),
            ),
          )
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
export const sync = (
  element: ReactNode,
  opts: { readonly pageId: string; readonly cache: NotionCache },
): Effect.Effect<SyncResult, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const prior = yield* opts.cache.load.pipe(
      Effect.mapError((cause) => new NotionSyncError({ reason: 'cache-load-failed', cause })),
    )
    const candidate = buildCandidateTree(element, opts.pageId)

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
    let drifted = false
    if (prior !== undefined && !schemaMismatch && !pageIdDrift) {
      const liveChildren = yield* Stream.runCollect(
        NotionBlocks.retrieveChildrenStream({ blockId: opts.pageId }),
      ).pipe(
        Effect.mapError(
          (cause) => new NotionSyncError({ reason: 'notion-retrieve-failed', cause }),
        ),
      )
      const liveIds = new Set<string>()
      for (const b of Chunk.toReadonlyArray(liveChildren)) {
        if (b.in_trash !== true) liveIds.add(b.id)
      }
      const expectedIds = new Set(prior.children.map((c) => c.blockId))
      if (liveIds.size !== expectedIds.size || [...expectedIds].some((id) => !liveIds.has(id))) {
        drifted = true
      }
    }

    const useCold = prior === undefined || drifted || pageIdDrift
    const base: CacheTree = useCold ? emptyCache(opts.pageId) : prior
    const fallbackReason: SyncFallbackReason | undefined = pageIdDrift
      ? 'page-id-drift'
      : drifted
        ? 'cache-drift'
        : prior === undefined
          ? 'cold-cache'
          : schemaMismatch
            ? 'schema-mismatch'
            : undefined

    const plan = diff(base, candidate)
    const idMap = new Map<string, string>()
    // Working copy of the cache tree — updated after each successful op,
    // flushed to the backend as a per-batch checkpoint (#102). On
    // mid-sync failure the cache reflects server state up to the last
    // checkpoint, so a retry diffs against a tree that already includes
    // the blocks that actually landed.
    const working = initWorkingCache(base)
    const flushCheckpoint: Effect.Effect<void, NotionSyncError> = Effect.suspend(() =>
      opts.cache
        .save(workingToCacheTree(working))
        .pipe(
          Effect.mapError((cause) => new NotionSyncError({ reason: 'cache-save-failed', cause })),
        ),
    )

    const resolve = (id: string): string => idMap.get(id) ?? id
    yield* applyDiff(plan, idMap, (event) =>
      Effect.gen(function* () {
        if (event.kind === 'appended') {
          for (const { op, serverId, afterId } of event.committed) {
            const parentId = resolve(op.parent)
            const node: WorkingNode = {
              key: op.candidate.key,
              blockId: serverId,
              type: op.type,
              hash: op.candidate.hash,
              children: [],
            }
            workingAppend(working, parentId, node, afterId)
          }
        } else if (event.kind === 'updated') {
          workingUpdate(working, event.op.blockId, event.op.type, event.op.hash)
        } else {
          workingRemove(working, event.op.blockId)
        }
        yield* flushCheckpoint
      }),
    )
    resolveTreeIds(candidate, idMap)

    // Final authoritative snapshot from the fully-resolved candidate.
    // Semantically identical to the working copy after the last op, but
    // also picks up any purely structural bookkeeping (e.g. hash of an
    // updated node that matches the candidate hash byte-for-byte).
    const tree = candidateToCache(candidate, CACHE_SCHEMA_VERSION)
    yield* opts.cache
      .save(tree)
      .pipe(Effect.mapError((cause) => new NotionSyncError({ reason: 'cache-save-failed', cause })))

    const counts = tallyDiff(plan)
    return fallbackReason === undefined ? counts : { ...counts, fallbackReason }
  })
