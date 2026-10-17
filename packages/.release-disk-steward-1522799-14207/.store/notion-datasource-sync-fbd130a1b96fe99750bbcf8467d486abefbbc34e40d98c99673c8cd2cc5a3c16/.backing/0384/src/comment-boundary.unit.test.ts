import { describe, expect, it } from 'vitest'

import type { NmdCommentUnit, NmdStorage } from '@overeng/notion-effect-client'

import { classifyCommentWrite } from './comment-boundary.ts'

/*
 * L0 unit coverage for the comment-write boundary (SM6.2).
 *
 * Mutation-implying, not presence-based: the boundary blocks only when the
 * inventory the write would PRODUCE differs from the CURRENT inventory (a comment
 * unit added/removed/modified). Merely having comments — with `produced` equal to
 * `current`, which is the case for every body-only write path today — is inert.
 * The block-detection cases feed a synthetic differing `produced` to prove the
 * dormant gate trips.
 */

const uuid = (n: number): `${string}-${string}-${string}-${string}-${string}` =>
  `00000000-0000-4000-8000-0000000000${n
    .toString()
    .padStart(2, '0')}` as `${string}-${string}-${string}-${string}-${string}`

const selfContained = (comments: readonly NmdCommentUnit[]): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: [],
  files: [],
  comments,
})

const emptyStorage = (): NmdStorage => selfContained([])

const syncedComment = selfContained([
  {
    _tag: 'comment_unit',
    id: 'comment-def',
    notion_comment_id: uuid(99),
    notion_discussion_id: uuid(98),
  },
])

const objectStore = (commentIds: readonly string[]): NmdStorage => ({
  _tag: 'object_store',
  object: {
    _tag: 'object_ref',
    role: 'storage_payload',
    hash: `sha256:${'c'.repeat(64)}`,
    path: 'objects/cc/storage.json',
    media_type: 'application/json',
    byte_length: 8,
  },
  unsupported_block_ids: [],
  file_ids: [],
  comment_ids: commentIds,
})

describe('classifyCommentWrite — inert (no comment mutation)', () => {
  it('is inert when there is no storage', () => {
    expect(classifyCommentWrite({ current: undefined, operation: 'push' })).toEqual({
      _tag: 'inert',
    })
  })

  it('is inert when self_contained storage has no comments', () => {
    expect(classifyCommentWrite({ current: emptyStorage(), operation: 'pull' })).toEqual({
      _tag: 'inert',
    })
  })

  it('is inert for a body-only write over a synced comment (produced defaults to current)', () => {
    // The body-only `replace_content` write path leaves the comment inventory
    // untouched, so a page that merely HAS comments must not block.
    expect(classifyCommentWrite({ current: syncedComment, operation: 'push' })).toEqual({
      _tag: 'inert',
    })
  })

  it('is inert for object_store with non-empty comment_ids on a body-only write', () => {
    expect(
      classifyCommentWrite({ current: objectStore(['comment-1', 'comment-2']), operation: 'pull' }),
    ).toEqual({ _tag: 'inert' })
  })

  it('is inert when produced equals current (explicit no-op mutation)', () => {
    expect(
      classifyCommentWrite({
        current: syncedComment,
        produced: syncedComment,
        operation: 'shared',
      }),
    ).toEqual({ _tag: 'inert' })
  })
})

describe('classifyCommentWrite — blocked (genuine comment mutation)', () => {
  it('blocks when a comment unit is added (create)', () => {
    const produced = selfContained([
      { _tag: 'comment_unit', id: 'comment-new', roughdraft_id: 'rd-001' },
    ])
    const verdict = classifyCommentWrite({ current: emptyStorage(), produced, operation: 'push' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.guard).toBe('CommentWriteUnsupported')
    expect(verdict.commentIds).toEqual(['comment-new'])
    expect(verdict.reason).toContain('comment-new')
    expect(verdict.reason).toContain('push')
  })

  it('blocks when a comment unit is removed (resolve/delete)', () => {
    const current = selfContained([
      { _tag: 'comment_unit', id: 'comment-gone', roughdraft_id: 'rd-002' },
    ])
    const verdict = classifyCommentWrite({ current, produced: emptyStorage(), operation: 'pull' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.guard).toBe('CommentWriteUnsupported')
    expect(verdict.commentIds).toEqual(['comment-gone'])
  })

  it('blocks when a comment unit is modified (edit)', () => {
    const current = selfContained([{ _tag: 'comment_unit', id: 'comment-x', anchor_text: 'old' }])
    const produced = selfContained([{ _tag: 'comment_unit', id: 'comment-x', anchor_text: 'new' }])
    const verdict = classifyCommentWrite({ current, produced, operation: 'shared' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.guard).toBe('CommentWriteUnsupported')
    expect(verdict.commentIds).toEqual(['comment-x'])
    expect(verdict.reason).toContain('shared')
  })

  it('blocks on an object_store comment-id mutation', () => {
    const verdict = classifyCommentWrite({
      current: objectStore(['comment-1']),
      produced: objectStore(['comment-1', 'comment-2']),
      operation: 'push',
    })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.commentIds).toEqual(['comment-2'])
  })
})
