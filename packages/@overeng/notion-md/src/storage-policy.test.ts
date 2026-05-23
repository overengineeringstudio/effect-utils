import { describe, expect, it } from 'vitest'

import type { NmdFrontmatterV1, NmdStorage } from '@overeng/notion-effect-client'

import { decideStorage } from './storage-policy.ts'

const pageId = '00000000-0000-4000-8000-000000000001'
const hash = `sha256:${'a'.repeat(64)}` as const

const frontmatterWithStorage = (storage: NmdStorage): NmdFrontmatterV1 => ({
  notion_md: {
    version: 1,
    api_version: '2026-03-11',
    object: 'page',
    page_id: pageId,
    url: 'https://www.notion.so/test',
    parent: { _tag: 'page', id: pageId },
    body: {
      format: 'notion-enhanced-markdown',
      hash,
      base: {
        _tag: 'object_ref',
        role: 'base_snapshot',
        hash,
        path: `.notion-md/objects/sha256/${'a'.repeat(2)}/${'a'.repeat(62)}.json`,
        media_type: 'application/json',
        byte_length: 128,
      },
      last_pulled_at: '2026-05-22T12:00:00.000Z',
      remote_last_edited_time: '2026-05-22T12:00:00.000Z',
      truncated: false,
      unknown_block_ids: [],
    },
    page: {
      title: 'Probe',
      icon: null,
      cover: null,
      in_trash: false,
      is_locked: false,
    },
    data_source: null,
    properties: {},
    storage,
  },
})

describe('notion-md storage policy', () => {
  it('keeps small stable storage self-contained', () => {
    const decision = decideStorage(
      frontmatterWithStorage({
        _tag: 'self_contained',
        unsupported_blocks: [],
        files: [],
        comments: [],
      }),
    )

    expect(decision).toMatchObject({ _tag: 'keep_self_contained', classification: 'small' })
  })

  it('moves volatile Notion file URLs into the content-addressed object store', () => {
    const decision = decideStorage(
      frontmatterWithStorage({
        _tag: 'self_contained',
        unsupported_blocks: [
          {
            _tag: 'unsupported_block',
            block_id: '00000000-0000-4000-8000-000000000002',
            block_type: 'image',
            placeholder: '<unsupported image />',
            snapshot: {
              object: 'block',
              id: '00000000-0000-4000-8000-000000000002',
              type: 'image',
              has_children: false,
              in_trash: false,
              parent: { type: 'page_id', page_id: pageId },
              created_time: '2026-05-22T12:00:00.000Z',
              last_edited_time: '2026-05-22T12:00:00.000Z',
              payload: {
                image: {
                  type: 'file',
                  file: {
                    url: 'https://secure.notion-static.com/example/hero.png?X-Amz-Signature=volatile',
                  },
                },
              },
            },
          },
        ],
        files: [
          {
            _tag: 'file_unit',
            id: 'hero',
            role: 'block_image',
            filename: 'hero.png',
            content_type: 'image/png',
            content_length: 128,
            local_path: 'attachments/hero.png',
            content_hash: hash,
          },
        ],
        comments: [],
      }),
    )

    expect(decision).toMatchObject({ _tag: 'requires_object_store', reason: 'volatile_url' })
  })
})
