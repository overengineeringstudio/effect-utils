import type { ReactNode } from 'react'

import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'

import { NotionBlocks, type NotionConfig } from '@overeng/notion-effect-client'

import { NotionSyncError } from './errors.ts'
import { createNotionRoot } from './host-config.ts'
import type { Op } from './op-buffer.ts'
import { OpBuffer } from './op-buffer.ts'

/** Summary of the ops applied during a render/sync pass. */
export type SyncResult = {
  readonly appends: number
  readonly updates: number
  readonly removes: number
  readonly inserts: number
  readonly fallbackReason?: string
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
const appendBody = (op: Extract<Op, { kind: 'append' | 'insertBefore' }>): Record<string, unknown> => ({
  object: 'block',
  type: op.type,
  [op.type]: op.props,
})

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

    for (const op of buffer.ops) {
      switch (op.kind) {
        case 'append': {
          const res = yield* NotionBlocks.append({
            blockId: resolve(op.parent),
            children: [appendBody(op)],
          }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-append-failed', cause }),
            ),
          )
          const first = res.results[0] as { id?: string } | undefined
          if (first?.id !== undefined) idMap.set(op.id, first.id)
          break
        }
        case 'insertBefore': {
          const res = yield* NotionBlocks.append({
            blockId: resolve(op.parent),
            children: [appendBody(op)],
            position: { type: 'after_block', after_block: { id: resolve(op.beforeId) } },
          }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-insert-failed', cause }),
            ),
          )
          const first = res.results[0] as { id?: string } | undefined
          if (first?.id !== undefined) idMap.set(op.id, first.id)
          break
        }
        case 'update': {
          yield* NotionBlocks.update({ blockId: resolve(op.id), [op.type]: op.props }).pipe(
            Effect.mapError((cause) => new NotionSyncError({ reason: 'notion-update-failed', cause })),
          )
          break
        }
        case 'remove': {
          yield* NotionBlocks.delete({ blockId: resolve(op.id) }).pipe(
            Effect.mapError((cause) => new NotionSyncError({ reason: 'notion-delete-failed', cause })),
          )
          break
        }
      }
    }

    return { ...tally(buffer.ops) }
  })
