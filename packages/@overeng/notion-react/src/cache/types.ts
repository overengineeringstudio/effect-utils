import { Schema, type Effect } from 'effect'

import type { CacheError } from '../renderer/errors.ts'

/** Current on-disk schema version. Bumping invalidates all cached trees. */
export const CACHE_SCHEMA_VERSION = 2 as const

export interface CacheNode {
  readonly key: string
  readonly blockId: string
  /**
   * Notion block type (e.g. `paragraph`, `heading_2`). Stored so the diff can
   * detect a same-key type change and emit remove+insert instead of an
   * illegal `update` op (Notion rejects type changes via update).
   */
  readonly type: string
  readonly hash: string
  readonly children: readonly CacheNode[]
}

export const CacheNode: Schema.Schema<CacheNode> = Schema.suspend(() =>
  Schema.Struct({
    key: Schema.String,
    blockId: Schema.String,
    type: Schema.String,
    hash: Schema.String,
    children: Schema.Array(CacheNode),
  }),
)

export const CacheTree = Schema.Struct({
  schemaVersion: Schema.Number,
  rootId: Schema.String,
  children: Schema.Array(CacheNode),
})

export type CacheTree = typeof CacheTree.Type

export interface NotionCache {
  readonly load: Effect.Effect<CacheTree | undefined, CacheError>
  readonly save: (tree: CacheTree) => Effect.Effect<void, CacheError>
}
