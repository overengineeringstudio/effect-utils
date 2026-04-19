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
 * Apply a pre-computed diff plan against Notion. Accumulates tmp-id →
 * real-id mappings into `idMap` as the server issues ids for appended /
 * inserted blocks.
 */
const applyDiff = (
  ops: readonly DiffOp[],
  idMap: Map<string, string>,
): Effect.Effect<void, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const resolve = (id: string): string => idMap.get(id) ?? id
    for (const op of ops) {
      switch (op.kind) {
        case 'append': {
          const res = yield* NotionBlocks.append({
            blockId: resolve(op.parent),
            children: [appendBody(op.type, op.props)],
          }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-append-failed', cause }),
            ),
          )
          const first = res.results[0] as { id?: string } | undefined
          if (first?.id !== undefined) idMap.set(op.tmpId, first.id)
          break
        }
        case 'insert': {
          const parentId = resolve(op.parent)
          const afterId = op.afterId === '' ? undefined : resolve(op.afterId)
          const res = yield* NotionBlocks.append({
            blockId: parentId,
            children: [appendBody(op.type, op.props)],
            ...(afterId !== undefined
              ? { position: { type: 'after_block' as const, after_block: { id: afterId } } }
              : {}),
          }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-insert-failed', cause }),
            ),
          )
          const first = res.results[0] as { id?: string } | undefined
          if (first?.id !== undefined) idMap.set(op.tmpId, first.id)
          break
        }
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
