/**
 * Comment-write boundary (SM6.2).
 *
 * notion-md has no v-next comment create/edit/resolve gateway yet, so any write
 * that would *mutate* the Notion comment inventory must fail closed with the
 * named guard `CommentWriteUnsupported` (R13) rather than silently dropping or
 * corrupting comment state.
 *
 * MUTATION-IMPLYING, NOT PRESENCE-BASED: comments are first-class Notion objects,
 * orthogonal to body content. The only write notion-md performs today is
 * `updateMarkdown({_tag:'replace_content'})`, which rewrites body blocks and is
 * structurally incapable of creating, editing, or resolving a Notion comment. So
 * a body-only edit on a page that *merely has* comments mutates nothing in the
 * comment inventory and must proceed. Blocking on presence would be fictitious
 * (the API call never touches comments) and would over-block legitimate body
 * edits on commented pages.
 *
 * {@link classifyCommentWrite} therefore compares the comment inventory the write
 * would PRODUCE against the CURRENT (base) inventory and returns `blocked` only
 * when the write would add, remove, or modify a comment unit — i.e. when it
 * implies a comment-API operation that does not yet exist. Otherwise it returns
 * `inert`.
 *
 * DORMANT FAIL-CLOSED GATE: at every current write site the produced inventory
 * is computed as `=== current` (body writes never touch comments), so the gate
 * is inert by construction everywhere today. `produced` is the seam where a
 * future comment-intent path (e.g. a Roughdraft-comment parser that derives a
 * new inventory from local review markup) would supply a genuinely different
 * value; the moment it does, this gate trips and forces that path to wire real
 * comment-API support explicitly rather than silently mutating comments.
 *
 * The reason string `'comments-api-not-implemented'` is shared with the
 * {@link CommentWebhookBoundary} so a single vocabulary covers both the trigger
 * and the write surfaces.
 *
 * @module
 */

import type { NmdCommentUnit, NmdStorage } from '@overeng/notion-effect-client'

import type { NonBodyGuardName } from './non-body-guards.ts'

/** A write operation classified by the comment boundary. */
export type CommentWriteOperation =
  /** Local Markdown push (local -> remote): a comment mutation would create/update Notion comments. */
  | 'push'
  /** Remote Markdown pull (remote -> local): a comment mutation would reconcile Notion comments. */
  | 'pull'
  /** Shared 3-way reconcile: a comment mutation would sync comments bidirectionally. */
  | 'shared'

/** Verdict of {@link classifyCommentWrite}. */
export type CommentWriteVerdict =
  | {
      /** The write does not mutate the comment inventory: it is safe to proceed. */
      readonly _tag: 'inert'
    }
  | {
      /** The write would add/remove/modify comment units: it is blocked. */
      readonly _tag: 'blocked'
      /** The violated non-body guard name. */
      readonly guard: NonBodyGuardName
      /** Ids of the comment units whose mutation triggered the block. */
      readonly commentIds: readonly string[]
      /** Human-readable explanation of the refusal. */
      readonly reason: string
    }

const commentUnitsOf = (storage: NmdStorage | undefined): readonly NmdCommentUnit[] => {
  if (storage === undefined) return []
  switch (storage._tag) {
    case 'self_contained':
      return storage.comments
    case 'object_store':
      // object_store keeps only opaque ids; model each as an id-only unit so the
      // diff below can detect added/removed ids across a mutation.
      return storage.comment_ids.map((id): NmdCommentUnit => ({ _tag: 'comment_unit', id }))
  }
}

/** Stable, order-independent fingerprint of a comment unit for diffing. */
const fingerprint = (unit: NmdCommentUnit): string =>
  JSON.stringify([
    unit.id,
    unit.roughdraft_id ?? null,
    unit.notion_comment_id ?? null,
    unit.notion_discussion_id ?? null,
    unit.anchor_text ?? null,
  ])

/** Ids of comment units that differ between `current` and `produced` (added, removed, or modified). */
const mutatedCommentIds = (opts: {
  readonly current: readonly NmdCommentUnit[]
  readonly produced: readonly NmdCommentUnit[]
}): readonly string[] => {
  const currentByFp = new Map(opts.current.map((u) => [fingerprint(u), u] as const))
  const producedByFp = new Map(opts.produced.map((u) => [fingerprint(u), u] as const))
  const ids = new Set<string>()
  for (const [fp, unit] of currentByFp) {
    if (producedByFp.has(fp) === false) ids.add(unit.id)
  }
  for (const [fp, unit] of producedByFp) {
    if (currentByFp.has(fp) === false) ids.add(unit.id)
  }
  return [...ids]
}

/**
 * Classify a comment-write at a reconcile write site.
 *
 * Compares the comment inventory the write would PRODUCE against the CURRENT
 * inventory and returns `blocked` only when they differ (a comment unit added,
 * removed, or modified) — that difference implies a Notion comments-API call,
 * which is not yet implemented in v-next notion-md. When the inventories match
 * (the body-only write paths that exist today), the verdict is `inert`.
 *
 * Fail-closed seam: the gate is dormant while `produced === current` but trips
 * the moment a future comment-intent path supplies a differing `produced`,
 * forcing that path to wire real comment-API support rather than silently
 * mutating comments.
 */
export const classifyCommentWrite = (opts: {
  readonly current: NmdStorage | undefined
  /**
   * The comment inventory the write would produce. Defaults to `current`: today
   * every write path is body-only and leaves the comment inventory untouched.
   * A future comment-intent path supplies a derived value here to opt in to the
   * (currently unimplemented) comment-mutation surface.
   */
  readonly produced?: NmdStorage | undefined
  readonly operation: CommentWriteOperation
}): CommentWriteVerdict => {
  const current = commentUnitsOf(opts.current)
  const produced = commentUnitsOf(opts.produced ?? opts.current)
  const commentIds = mutatedCommentIds({ current, produced })
  if (commentIds.length === 0) return { _tag: 'inert' }

  return {
    _tag: 'blocked',
    guard: 'CommentWriteUnsupported',
    commentIds,
    reason: `would mutate the modeled comment inventory (${commentIds.join(', ')}); ${opts.operation} requires the Notion comments API, which is not yet implemented in v-next notion-md`,
  }
}
