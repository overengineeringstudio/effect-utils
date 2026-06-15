/**
 * Comment-write boundary (SM6.2).
 *
 * notion-md has no v-next comment create/edit/resolve gateway yet, so any write
 * that would carry a non-empty modeled comment inventory must fail closed with
 * the named guard `CommentWriteUnsupported` (R13) rather than silently dropping
 * or corrupting comment state.
 *
 * {@link classifyCommentWrite} inspects the storage's comment inventory and
 * returns either `inert` (proven safe to proceed — no comment API call needed)
 * or `blocked` (non-empty comment inventory; the write would need the comments
 * API, which is not yet implemented).
 *
 * FAIL-CLOSED CONTRACT: `inert` requires a provably empty comment inventory
 * (no `NmdCommentUnit` entries in self-contained storage; no `comment_ids`
 * entries in object-store storage). Any non-empty inventory blocks, regardless
 * of whether the entries carry Notion IDs. This is symmetric to the media
 * boundary (SM6.1): both boundaries gate on non-empty inventory at write sites
 * rather than attempting partial-sync semantics that would require missing API
 * support.
 *
 * PRESERVATION: comment inventory preservation is supported through the sidecar
 * layer. `trackPage({source:'shared'})` writes the comment inventory into the
 * sidecar at track time, so it survives independently of the write gate.
 * `statusFile` is read-only and never reaches the write gate. The write gate
 * is only evaluated in write branches (push / pull / shared-merge).
 *
 * NOTE: this boundary also blocks when all comments already carry Notion IDs
 * (i.e. a previously-synced inventory). That is intentional: the single-source
 * `local`/`remote` write paths are stateless — they write no sidecar — so
 * there is nowhere to persist the inventory after a write. Letting a synced
 * comment through would silently drop it. Presence-based fail-closed (symmetric
 * to SM6.1) is the safe default until a sidecar-aware comment-update path
 * exists.
 *
 * The reason string `'comments-api-not-implemented'` is shared with the
 * {@link CommentWebhookBoundary} so a single vocabulary covers both the trigger
 * and the write surfaces.
 *
 * @module
 */

import type { NmdStorage } from '@overeng/notion-effect-client'

import type { NonBodyGuardName } from './non-body-guards.ts'

/** A write operation classified by the comment boundary. */
export type CommentWriteOperation =
  /** Local Markdown push (local -> remote): would require creating/updating Notion comments. */
  | 'push'
  /** Remote Markdown pull (remote -> local): would require fetching Notion comments. */
  | 'pull'
  /** Shared 3-way reconcile: would require bidirectional comment sync. */
  | 'shared'

/** Verdict of {@link classifyCommentWrite}. */
export type CommentWriteVerdict =
  | {
      /** Empty comment inventory: the write is safe to proceed. */
      readonly _tag: 'inert'
    }
  | {
      /** Non-empty comment inventory: the write is blocked. */
      readonly _tag: 'blocked'
      /** The violated non-body guard name. */
      readonly guard: NonBodyGuardName
      /** Ids of the comment units that triggered the block. */
      readonly commentIds: readonly string[]
      /** Human-readable explanation of the refusal. */
      readonly reason: string
    }

const commentUnitsOf = (storage: NmdStorage | undefined): readonly string[] => {
  if (storage === undefined) return []
  switch (storage._tag) {
    case 'self_contained':
      return storage.comments.map((c) => c.id)
    case 'object_store':
      return storage.comment_ids
  }
}

/**
 * Classify a comment-write at a reconcile write site.
 *
 * Returns `inert` only when the comment inventory is provably empty (no
 * `NmdCommentUnit` entries in self-contained storage; no `comment_ids` in
 * object-store storage). Any non-empty inventory returns `blocked` with the
 * `CommentWriteUnsupported` guard and the offending comment ids.
 *
 * Fail-closed by construction: positive proof of an empty inventory is required
 * for `inert`, never the mere absence of API calls. This ensures future code
 * that adds comment mutation paths is forced to remove or supersede this guard
 * explicitly rather than silently bypassing it.
 */
export const classifyCommentWrite = (opts: {
  readonly storage: NmdStorage | undefined
  readonly operation: CommentWriteOperation
}): CommentWriteVerdict => {
  const commentIds = commentUnitsOf(opts.storage)
  if (commentIds.length === 0) return { _tag: 'inert' }

  return {
    _tag: 'blocked',
    guard: 'CommentWriteUnsupported',
    commentIds,
    reason: `contains modeled comment inventory (${commentIds.join(', ')}); ${opts.operation} would require the Notion comments API, which is not yet implemented in v-next notion-md`,
  }
}
