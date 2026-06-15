import { describe, expect, it } from 'vitest'

import type { NmdStorage } from '@overeng/notion-effect-client'

import { classifyCommentWrite } from './comment-boundary.ts'

/*
 * L0 unit coverage for the comment-write boundary (SM6.2).
 *
 * Fail-closed: `inert` requires a provably empty comment inventory. Any
 * non-empty inventory blocks with `CommentWriteUnsupported` regardless of
 * whether individual units carry Notion IDs (that distinction belongs to a
 * future comments-API bridge, not this boundary).
 */

const emptyStorage = (): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: [],
  files: [],
  comments: [],
})

const withComment = (): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: [],
  files: [],
  comments: [
    {
      _tag: 'comment_unit',
      id: 'comment-abc',
      roughdraft_id: 'rd-001',
    },
  ],
})

const withSyncedComment = (): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: [],
  files: [],
  comments: [
    {
      _tag: 'comment_unit',
      id: 'comment-def',
      notion_comment_id:
        '00000000-0000-4000-8000-000000000099' as `${string}-${string}-${string}-${string}-${string}`,
      notion_discussion_id:
        '00000000-0000-4000-8000-000000000098' as `${string}-${string}-${string}-${string}-${string}`,
    },
  ],
})

const objectStoreWithComments = (): NmdStorage => ({
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
  comment_ids: ['comment-1', 'comment-2'],
})

describe('classifyCommentWrite', () => {
  it('is inert when there is no storage', () => {
    expect(classifyCommentWrite({ storage: undefined, operation: 'push' })).toEqual({
      _tag: 'inert',
    })
  })

  it('is inert when self_contained storage has no comments', () => {
    expect(classifyCommentWrite({ storage: emptyStorage(), operation: 'pull' })).toEqual({
      _tag: 'inert',
    })
  })

  it('is inert when object_store has empty comment_ids', () => {
    const storage: NmdStorage = {
      _tag: 'object_store',
      object: {
        _tag: 'object_ref',
        role: 'storage_payload',
        hash: `sha256:${'d'.repeat(64)}`,
        path: 'objects/dd/storage.json',
        media_type: 'application/json',
        byte_length: 8,
      },
      unsupported_block_ids: [],
      file_ids: [],
      comment_ids: [],
    }
    expect(classifyCommentWrite({ storage, operation: 'shared' })).toEqual({ _tag: 'inert' })
  })

  it('blocks on push when storage has a comment unit', () => {
    const verdict = classifyCommentWrite({ storage: withComment(), operation: 'push' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.guard).toBe('CommentWriteUnsupported')
    expect(verdict.commentIds).toEqual(['comment-abc'])
    expect(verdict.reason).toContain('comment-abc')
    expect(verdict.reason).toContain('push')
  })

  it('blocks on pull when storage has a comment unit', () => {
    const verdict = classifyCommentWrite({ storage: withComment(), operation: 'pull' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.guard).toBe('CommentWriteUnsupported')
  })

  it('blocks on shared when storage has a comment unit', () => {
    const verdict = classifyCommentWrite({ storage: withComment(), operation: 'shared' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.guard).toBe('CommentWriteUnsupported')
    expect(verdict.reason).toContain('shared')
  })

  it('fails closed on a fully-synced comment unit (has notion_comment_id) — no partial sync', () => {
    // Even a comment that was previously synced still blocks: determining
    // whether it needs an UPDATE call is future work. The boundary is
    // conservative: any non-empty inventory blocks.
    const verdict = classifyCommentWrite({ storage: withSyncedComment(), operation: 'push' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.guard).toBe('CommentWriteUnsupported')
    expect(verdict.commentIds).toEqual(['comment-def'])
  })

  it('blocks on object_store with non-empty comment_ids', () => {
    const verdict = classifyCommentWrite({ storage: objectStoreWithComments(), operation: 'pull' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.guard).toBe('CommentWriteUnsupported')
    expect(verdict.commentIds).toEqual(['comment-1', 'comment-2'])
  })
})
