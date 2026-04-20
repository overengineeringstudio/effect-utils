import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import type { ReactNode } from 'react'

import { NotionBlocks, type NotionConfig } from '@overeng/notion-effect-client'

import type { CacheTree, NotionCache } from '../cache/types.ts'
import { CACHE_SCHEMA_VERSION } from '../cache/types.ts'
import { NotionSyncError } from './errors.ts'
import type { SyncResult } from './render-to-notion.ts'
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
): Effect.Effect<void, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (run.length === 0) return
    const parentId = resolve(run[0]!.parent)
    const first = run[0]!
    // `afterId` for the first batch; subsequent batches override with the
    // last-minted id from the prior batch. Empty afterId ('' head marker
    // or `append` kind) ⇒ no `position` envelope at all.
    let nextAfter: string | undefined =
      first.kind === 'insert' && first.afterId !== '' ? resolve(first.afterId) : undefined

    for (let start = 0; start < run.length; start += APPEND_CHILDREN_MAX) {
      const batch = run.slice(start, start + APPEND_CHILDREN_MAX)
      const children = batch.map((op) => appendBody(op.type, op.props))
      const res = yield* NotionBlocks.append({
        blockId: parentId,
        children,
        ...(nextAfter !== undefined
          ? { position: { type: 'after_block' as const, after_block: { id: nextAfter } } }
          : {}),
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
      let lastId: string | undefined
      for (let i = 0; i < batch.length; i++) {
        const serverId = results[i]?.id
        if (serverId !== undefined) {
          idMap.set(batch[i]!.tmpId, serverId)
          lastId = serverId
        }
      }
      // Anchor subsequent batches on the last-minted id so positional
      // semantics are preserved under concurrent modifications.
      nextAfter = lastId ?? nextAfter
    }
  })

/**
 * Apply a pre-computed diff plan against Notion. Consecutive append/insert
 * ops sharing a parent are coalesced into batched API calls (#101).
 * Accumulates tmp-id → real-id mappings into `idMap` as the server issues
 * ids for appended / inserted blocks.
 */
const applyDiff = (
  ops: readonly DiffOp[],
  idMap: Map<string, string>,
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
        yield* flushAppendRun(ops.slice(runStart, i) as AppendLike[], idMap, resolve)
        continue
      }
      switch (op.kind) {
        case 'update': {
          yield* NotionBlocks.update({ blockId: op.blockId, [op.type]: op.props }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-update-failed', cause }),
            ),
          )
          break
        }
        case 'remove': {
          yield* NotionBlocks.delete({ blockId: op.blockId }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-delete-failed', cause }),
            ),
          )
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
    // On schema mismatch we still diff against the stale tree — keys and
    // hashes remain meaningful enough to avoid duplicate content. Migrations
    // that require a hard rebuild should bump the schema explicitly and
    // clear the cache out-of-band.
    const base: CacheTree = prior === undefined ? emptyCache(opts.pageId) : prior
    const fallbackReason =
      prior === undefined ? 'cold-cache' : schemaMismatch ? 'schema-mismatch' : undefined

    const plan = diff(base, candidate)
    const idMap = new Map<string, string>()
    yield* applyDiff(plan, idMap)
    resolveTreeIds(candidate, idMap)

    const tree = candidateToCache(candidate, CACHE_SCHEMA_VERSION)
    yield* opts.cache
      .save(tree)
      .pipe(Effect.mapError((cause) => new NotionSyncError({ reason: 'cache-save-failed', cause })))

    const counts = tallyDiff(plan)
    return fallbackReason === undefined ? counts : { ...counts, fallbackReason }
  })
