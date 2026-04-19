import { Effect, Schema } from 'effect'

import { CacheError } from '../renderer/errors.ts'

/** Current on-disk schema version. Bumping invalidates all cached trees. */
export const CACHE_SCHEMA_VERSION = 1 as const

export interface CacheNode {
  readonly key: string
  readonly blockId: string
  readonly hash: string
  readonly children: readonly CacheNode[]
}

export const CacheNode: Schema.Schema<CacheNode> = Schema.suspend(() =>
  Schema.Struct({
    key: Schema.String,
    blockId: Schema.String,
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
