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
  /**
   * Whether this cache entry describes a block or a (sub)page. Forward-compat
   * field for the page-ops work (issue #618): existing v2 caches were written
   * before this field existed and must continue to deserialize — the default
   * of `'block'` preserves their semantics. No emitter currently produces
   * `'page'` entries; the field exists so the schema is stable ahead of the
   * driver change that starts writing them.
   */
  readonly nodeKind: 'block' | 'page'
  /**
   * Hash of the page's `title` property. Reserved for page-scope reconciliation
   * (issue #618 phase 2+). Unset on block entries and on v2 caches written
   * before the field existed.
   */
  readonly titleHash?: string | undefined
  /**
   * Hash of the page's `icon` property. See {@link CacheNode.titleHash}.
   */
  readonly iconHash?: string | undefined
  /**
   * Hash of the page's `cover` property. See {@link CacheNode.titleHash}.
   */
  readonly coverHash?: string | undefined
}

/**
 * On-disk encoding of {@link CacheNode}. Mirrors `Type` except `nodeKind` is
 * optional — existing v2 caches were written before the field existed and
 * must still deserialize. The decoder fills in `'block'` as the default.
 */
interface CacheNodeEncoded {
  readonly key: string
  readonly blockId: string
  readonly type: string
  readonly hash: string
  readonly children: readonly CacheNodeEncoded[]
  readonly nodeKind?: 'block' | 'page' | undefined
  readonly titleHash?: string | undefined
  readonly iconHash?: string | undefined
  readonly coverHash?: string | undefined
}

export const CacheNode: Schema.Schema<CacheNode, CacheNodeEncoded> = Schema.suspend(() =>
  Schema.Struct({
    key: Schema.String,
    blockId: Schema.String,
    type: Schema.String,
    hash: Schema.String,
    children: Schema.Array(CacheNode),
    // `optionalWith({ default })` keeps existing v2 caches decodable: entries
    // serialized before this field existed default to `'block'`, which matches
    // the legacy "every cache node is a block" invariant.
    nodeKind: Schema.optionalWith(Schema.Literal('block', 'page'), {
      default: () => 'block' as const,
    }),
    titleHash: Schema.optional(Schema.String),
    iconHash: Schema.optional(Schema.String),
    coverHash: Schema.optional(Schema.String),
  }),
)

export const CacheTree = Schema.Struct({
  schemaVersion: Schema.Number,
  rootId: Schema.String,
  children: Schema.Array(CacheNode),
  /**
   * Hashes of the root page's title / icon / cover (issue #618 phase 3b).
   * Optional so v2 caches written before phase 3b still decode cleanly. When
   * absent, the first post-upgrade sync treats any candidate metadata as
   * drift and emits a single spurious root `updatePage`. Acceptable per the
   * phase-3b scope — phase 3c bumps the schema version properly.
   */
  rootTitleHash: Schema.optional(Schema.String),
  rootIconHash: Schema.optional(Schema.String),
  rootCoverHash: Schema.optional(Schema.String),
})

export type CacheTree = typeof CacheTree.Type

export interface NotionCache {
  readonly load: Effect.Effect<CacheTree | undefined, CacheError>
  readonly save: (tree: CacheTree) => Effect.Effect<void, CacheError>
}
