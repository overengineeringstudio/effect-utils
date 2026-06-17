import { describe, expect, it } from 'vitest'

import type { NmdStorage } from '@overeng/notion-effect-client'

import { classifyMediaWrite } from './media-boundary.ts'

/*
 * L0 unit coverage for the files/media write boundary (SM6.1).
 *
 * The boundary fails closed: `inert` requires positive proof of durability
 * (an empty file-unit set), never the mere absence of byte fields. Any
 * representable file unit — byte-backed OR ambiguous — blocks with a named
 * guard.
 */

const emptySelfContained = (): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: [],
  files: [],
  comments: [],
})

const byteBackedStorage = (): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: [],
  files: [
    {
      _tag: 'file_unit',
      id: 'hero-image',
      role: 'block_image',
      filename: 'hero.png',
      content_type: 'image/png',
      content_length: 70,
      local_path: 'attachments/hero.png',
      content_hash: `sha256:${'a'.repeat(64)}`,
      block_id: '00000000-0000-4000-8000-000000000003',
    },
  ],
  comments: [],
})

/** A file unit carrying none of the byte-transfer fields: ambiguous, must block. */
const ambiguousStorage = (): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: [],
  files: [
    {
      _tag: 'file_unit',
      id: 'mystery',
      role: 'block_file',
      filename: 'mystery.bin',
    },
  ],
  comments: [],
})

const objectStoreWithFiles = (): NmdStorage => ({
  _tag: 'object_store',
  object: {
    _tag: 'object_ref',
    role: 'storage_payload',
    hash: `sha256:${'b'.repeat(64)}`,
    path: 'objects/bb/storage.json',
    media_type: 'application/json',
    byte_length: 12,
  },
  unsupported_block_ids: [],
  file_ids: ['file-1', 'file-2'],
  comment_ids: [],
})

describe('classifyMediaWrite', () => {
  it('is inert when there is no storage', () => {
    expect(classifyMediaWrite({ storage: undefined, operation: 'push' })).toEqual({ _tag: 'inert' })
  })

  it('is inert when self_contained storage carries no file units (external-URL-only reduces here)', () => {
    expect(classifyMediaWrite({ storage: emptySelfContained(), operation: 'pull' })).toEqual({
      _tag: 'inert',
    })
  })

  it('blocks a byte-backed file unit on push with DurableFileUploadUnsupported', () => {
    const verdict = classifyMediaWrite({ storage: byteBackedStorage(), operation: 'push' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.guard).toBe('DurableFileUploadUnsupported')
    expect(verdict.fileIds).toEqual(['hero-image'])
    expect(verdict.reason).toContain('hero-image')
  })

  it('blocks a byte-backed file unit on pull with DurableFileWriteUnsupported', () => {
    const verdict = classifyMediaWrite({ storage: byteBackedStorage(), operation: 'pull' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.guard).toBe('DurableFileWriteUnsupported')
  })

  it('blocks a shared write with DurableFileWriteUnsupported', () => {
    const verdict = classifyMediaWrite({ storage: byteBackedStorage(), operation: 'shared' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.guard).toBe('DurableFileWriteUnsupported')
  })

  it('fails closed: an ambiguous file unit (no byte fields, no external marker) blocks', () => {
    const verdict = classifyMediaWrite({ storage: ambiguousStorage(), operation: 'push' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.guard).toBe('DurableFileUploadUnsupported')
    expect(verdict.fileIds).toEqual(['mystery'])
  })

  it('blocks an object_store with modeled file ids', () => {
    const verdict = classifyMediaWrite({ storage: objectStoreWithFiles(), operation: 'pull' })
    expect(verdict._tag).toBe('blocked')
    if (verdict._tag !== 'blocked') throw new Error('expected blocked')
    expect(verdict.fileIds).toEqual(['file-1', 'file-2'])
  })
})
