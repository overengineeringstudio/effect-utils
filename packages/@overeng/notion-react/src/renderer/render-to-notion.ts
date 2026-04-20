import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import type { ReactNode } from 'react'

import { NotionBlocks, type NotionConfig } from '@overeng/notion-effect-client'
import type { BlockType } from '@overeng/notion-effect-schema'

import { NotionSyncError } from './errors.ts'
import { createNotionRoot } from './host-config.ts'
import type { Op } from './op-buffer.ts'
import { OpBuffer } from './op-buffer.ts'

/**
 * Block types that Notion's `blocks.children.append` endpoint refuses to
 * accept without their descendants inlined in the same request. For these
 * we collapse the op-buffer subtree into a single nested API body instead
 * of issuing one call per block.
 */
export const ATOMIC_CONTAINERS: ReadonlySet<BlockType> = new Set<BlockType>(['column_list'])

/**
 * Reason the warm-path diff was bypassed. Unset on a clean incremental sync.
 *
 * - `cold-cache`: no prior snapshot; full append.
 * - `schema-mismatch`: on-disk schema is not the current
 *   `CACHE_SCHEMA_VERSION`; the renderer still diffs, but downstream
 *   consumers may want to clear the cache explicitly.
 * - `cache-drift`: the live page's top-level children diverged from the
 *   cached tree (another client archived/added blocks out-of-band); the
 *   renderer rebuilds from scratch to reconverge.
 * - `page-id-drift`: the cache was written against a different pageId
 *   than the one passed to `sync`; diffing would target ids on the wrong
 *   page, so we cold-start.
 */
export type SyncFallbackReason = 'cold-cache' | 'schema-mismatch' | 'cache-drift' | 'page-id-drift'

/** Summary of the ops applied during a render/sync pass. */
export type SyncResult = {
  readonly appends: number
  readonly updates: number
  readonly removes: number
  readonly inserts: number
  readonly fallbackReason?: SyncFallbackReason
}

const tally = (ops: readonly Op[]): Omit<SyncResult, 'fallbackReason'> => {
  let appends = 0
  let updates = 0
  let removes = 0
  let inserts = 0
  for (const op of ops) {
    switch (op.kind) {
      case 'append':
        appends += 1
        break
      case 'insertBefore':
        inserts += 1
        break
      case 'update':
        updates += 1
        break
      case 'remove':
        removes += 1
        break
    }
  }
  return { appends, updates, removes, inserts }
}

/**
 * Collect the op-buffer produced by a one-shot React render of `element`.
 *
 * Exposed for tests and for the cache-backed `sync` driver.
 */
export const collectOps = (element: ReactNode, rootId: string): OpBuffer => {
  const buffer = new OpBuffer(rootId)
  const root = createNotionRoot(buffer, rootId)
  root.render(element)
  return buffer
}

/** Body payload for a block `append` op. */
const appendBody = (
  op: Extract<Op, { kind: 'append' | 'insertBefore' }>,
): Record<string, unknown> => ({
  object: 'block',
  type: op.type,
  [op.type]: op.props,
})

type AppendLikeOp = Extract<Op, { kind: 'append' | 'insertBefore' }>

/**
 * Group append/insertBefore ops by their parent (temp) id so an atomic
 * container can reconstruct its descendant subtree without scanning the
 * full op list for every node.
 */
export const indexChildren = (ops: readonly Op[]): ReadonlyMap<string, readonly AppendLikeOp[]> => {
  const out = new Map<string, AppendLikeOp[]>()
  for (const op of ops) {
    if (op.kind !== 'append' && op.kind !== 'insertBefore') continue
    const list = out.get(op.parent) ?? []
    list.push(op)
    out.set(op.parent, list)
  }
  return out
}

/**
 * Build a nested `{object, type, <type>: {...props, children?}}` body for an
 * atomic container. Descendant ops are spliced under the container's props
 * via the `children` array, recursively.
 */
export const nestedBody = (
  op: AppendLikeOp,
  childrenIndex: ReadonlyMap<string, readonly AppendLikeOp[]>,
): Record<string, unknown> => {
  const kids = childrenIndex.get(op.id) ?? []
  const payload: Record<string, unknown> = { ...op.props }
  if (kids.length > 0) {
    payload.children = kids.map((k) => nestedBody(k, childrenIndex))
  }
  return { object: 'block', type: op.type, [op.type]: payload }
}

/** Collect the ids of all transitive descendants of `rootId` from the children index. */
const descendantIds = (
  rootId: string,
  childrenIndex: ReadonlyMap<string, readonly AppendLikeOp[]>,
): ReadonlySet<string> => {
  const seen = new Set<string>()
  const walk = (parent: string): void => {
    for (const kid of childrenIndex.get(parent) ?? []) {
      if (seen.has(kid.id)) continue
      seen.add(kid.id)
      walk(kid.id)
    }
  }
  walk(rootId)
  return seen
}

/**
 * Render `element` to Notion in append-only mode. Assumes the target page
 * has no pre-existing children this renderer owns; suitable for first-time
 * creation. For incremental updates against a prior state, use `sync`.
 *
 * Temporary block ids issued by the OpBuffer are mapped to real Notion ids
 * returned by `NotionBlocks.append` so nested inserts resolve correctly.
 */
export const renderToNotion = (
  element: ReactNode,
  opts: { readonly pageId: string },
): Effect.Effect<SyncResult, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const buffer = collectOps(element, opts.pageId)
    const idMap = new Map<string, string>()
    const resolve = (id: string): string => idMap.get(id) ?? id
    const childrenIndex = indexChildren(buffer.ops)
    // Temp ids of descendants under an atomic container we've already emitted;
    // their individual append ops are skipped since they shipped inline.
    const absorbed = new Set<string>()

    for (const op of buffer.ops) {
      if ('id' in op && absorbed.has(op.id)) continue
      switch (op.kind) {
        case 'append': {
          const atomic = ATOMIC_CONTAINERS.has(op.type)
          const body = atomic ? nestedBody(op, childrenIndex) : appendBody(op)
          const res = yield* NotionBlocks.append({
            blockId: resolve(op.parent),
            children: [body],
          }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-append-failed', cause }),
            ),
          )
          const first = res.results[0] as { id?: string } | undefined
          if (first?.id !== undefined) idMap.set(op.id, first.id)
          if (atomic) for (const d of descendantIds(op.id, childrenIndex)) absorbed.add(d)
          break
        }
        case 'insertBefore': {
          const atomic = ATOMIC_CONTAINERS.has(op.type)
          const body = atomic ? nestedBody(op, childrenIndex) : appendBody(op)
          const res = yield* NotionBlocks.append({
            blockId: resolve(op.parent),
            children: [body],
            position: { type: 'after_block', after_block: { id: resolve(op.beforeId) } },
          }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-insert-failed', cause }),
            ),
          )
          const first = res.results[0] as { id?: string } | undefined
          if (first?.id !== undefined) idMap.set(op.id, first.id)
          if (atomic) for (const d of descendantIds(op.id, childrenIndex)) absorbed.add(d)
          break
        }
        case 'update': {
          yield* NotionBlocks.update({ blockId: resolve(op.id), [op.type]: op.props }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-update-failed', cause }),
            ),
          )
          break
        }
        case 'remove': {
          yield* NotionBlocks.delete({ blockId: resolve(op.id) }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-delete-failed', cause }),
            ),
          )
          break
        }
      }
    }

    return { ...tally(buffer.ops) }
  })
