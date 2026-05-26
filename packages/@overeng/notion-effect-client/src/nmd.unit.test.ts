import { describe, expect, it } from 'vitest'

import {
  classifyNmdFrontmatterPayload,
  decodeNmdFrontmatterV1Sync,
  makeNmdObjectRef,
  nmdObjectRelativePath,
  nmdSha256Hex,
  nmdSyncStateRelativePath,
  type NmdFrontmatterV1,
} from './nmd.ts'

const hash = `sha256:${'a'.repeat(64)}`

const baseFrontmatter = {
  notion_md: {
    version: 1,
    api_version: '2026-03-11',
    object: 'page',
    page_id: '00000000-0000-4000-8000-000000000001',
    parent: { _tag: 'page', id: '00000000-0000-4000-8000-000000000001' },
    body: {
      format: 'notion-enhanced-markdown',
      hash,
      base: {
        _tag: 'object_ref',
        role: 'base_snapshot',
        hash,
        path: nmdObjectRelativePath(hash),
        media_type: 'application/json',
        byte_length: 128,
      },
      last_pulled_at: '2026-05-22T14:50:00.000Z',
      remote_last_edited_time: '2026-05-22T14:49:59.000Z',
      truncated: false,
      unknown_block_ids: [],
    },
    page: {
      title: 'Frontmatter experiment',
      icon: null,
      cover: null,
      in_trash: false,
      is_locked: false,
    },
    data_source: null,
    properties: {
      Name: { _tag: 'title', value: 'Frontmatter experiment' },
      Status: { _tag: 'select', value: 'Ready' },
      Tags: { _tag: 'multi_select', value: ['alpha', 'beta'] },
      Done: { _tag: 'checkbox', value: true },
      Due: {
        _tag: 'date',
        value: { start: '2026-05-22', end: null, time_zone: null },
      },
    },
    storage: {
      _tag: 'self_contained',
      unsupported_blocks: [
        {
          _tag: 'unsupported_block',
          block_id: '00000000-0000-4000-8000-000000000002',
          block_type: 'bookmark',
          placeholder: '<unknown url="..." alt="bookmark"/>',
          snapshot: {
            object: 'block',
            id: '00000000-0000-4000-8000-000000000002',
            type: 'bookmark',
            has_children: false,
            in_trash: false,
            parent: { type: 'page_id', page_id: 'page-id' },
            created_time: '2026-05-22T14:50:00.000Z',
            last_edited_time: '2026-05-22T14:50:00.000Z',
            payload: {
              url: 'https://www.notion.com/',
              caption: [],
            },
          },
        },
      ],
      files: [
        {
          _tag: 'file_unit',
          id: 'tiny-image',
          role: 'block_image',
          filename: 'tiny.png',
          content_type: 'image/png',
          content_length: 70,
          content_hash: hash,
        },
      ],
      comments: [
        {
          _tag: 'comment_unit',
          id: 'c1',
          roughdraft_id: 'c1',
          anchor_text: 'anchored text',
        },
      ],
    },
  },
} satisfies NmdFrontmatterV1

describe('NmdFrontmatterV1', () => {
  it('decodes tagged, self-contained frontmatter metadata', () => {
    const decoded = decodeNmdFrontmatterV1Sync(baseFrontmatter)

    expect(decoded.notion_md.storage._tag).toBe('self_contained')
    expect(decoded.notion_md.properties.Status).toEqual({ _tag: 'select', value: 'Ready' })
  })

  it('rejects untagged property values', () => {
    expect(() =>
      decodeNmdFrontmatterV1Sync({
        ...baseFrontmatter,
        notion_md: {
          ...baseFrontmatter.notion_md,
          properties: {
            Status: { type: 'select', value: 'Ready' },
          },
        },
      }),
    ).toThrow()
  })

  it('rejects excess keys in strict metadata', () => {
    expect(() =>
      decodeNmdFrontmatterV1Sync({
        ...baseFrontmatter,
        notion_md: {
          ...baseFrontmatter.notion_md,
          accidental_sidecar: 'doc.notion.json',
        },
      }),
    ).toThrow()
  })

  it('classifies self-contained payload size before deciding sidecar policy', () => {
    const small = classifyNmdFrontmatterPayload(baseFrontmatter)
    const forcedLarge = classifyNmdFrontmatterPayload(baseFrontmatter, {
      smallBytes: 1,
      largeBytes: 1_000_000,
    })

    expect(small.classification).toBe('small')
    expect(small.bytes).toBeGreaterThan(0)
    expect(forcedLarge.classification).toBe('large')
  })
})

describe('NMD local metadata paths', () => {
  it('derives the sharded object path from a SHA-256 digest', () => {
    expect(nmdSha256Hex(hash)).toBe('a'.repeat(64))
    expect(nmdObjectRelativePath(hash)).toBe(
      `.notion-md/objects/sha256/${'a'.repeat(2)}/${'a'.repeat(62)}.json`,
    )
  })

  it('derives sidecar sync-state paths under the NMD metadata root', () => {
    expect(nmdSyncStateRelativePath('00000000-0000-4000-8000-000000000001')).toBe(
      '.notion-md/sync/00000000-0000-4000-8000-000000000001.json',
    )
  })

  it('builds strict object refs with canonical paths and byte lengths', () => {
    expect(makeNmdObjectRef({ role: 'base_snapshot', hash, content: 'hello\n' })).toEqual({
      _tag: 'object_ref',
      role: 'base_snapshot',
      hash,
      path: nmdObjectRelativePath(hash),
      media_type: 'application/json',
      byte_length: 6,
    })
  })
})
