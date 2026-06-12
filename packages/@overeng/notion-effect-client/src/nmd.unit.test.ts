import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  classifyNmdFrontmatterPayload,
  decodeNmdFrontmatterV1Sync,
  decodeNmdFrontmatterV2Sync,
  gateNmdLocalState,
  makeNmdObjectRef,
  NmdParentRef,
  NmdStatelessnessError,
  nmdObjectRelativePath,
  nmdSha256Hex,
  nmdSyncStateRelativePath,
  type NmdFrontmatterV1,
  type NmdSyncStateV1,
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

describe('NmdParentRef', () => {
  const decode = Schema.decodeUnknownSync(NmdParentRef)
  const id = '00000000-0000-4000-8000-000000000001'

  it('round-trips an agent parent (Custom Agent instruction pages)', () => {
    expect(decode({ _tag: 'agent', id })).toEqual({ _tag: 'agent', id })
  })
})

const pageId = '00000000-0000-4000-8000-000000000001'
const parentId = '00000000-0000-4000-8000-000000000000'

const frontmatterV2 = (overrides: {
  readonly source?: string
  readonly page_id?: string | null
}): unknown => ({
  notion_md: {
    version: 2,
    api_version: '2026-03-11',
    object: 'page',
    ...(overrides.source === undefined ? {} : { source: overrides.source }),
    page_id: overrides.page_id === undefined ? pageId : overrides.page_id,
    parent: { _tag: 'page', id: parentId },
    page: { title: 'T', icon: null, cover: null, in_trash: false, is_locked: false },
    properties: {},
  },
})

const syncState: NmdSyncStateV1 = {
  version: 1,
  page_id: pageId,
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
  storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
  read_only_properties: {},
  data_source: null,
}

describe('NmdFrontmatterV2 source field (R34)', () => {
  it('rejects missing source instead of defaulting to local', () => {
    expect(() => decodeNmdFrontmatterV2Sync(frontmatterV2({}))).toThrow()
  })

  it('decodes an explicit source: remote', () => {
    expect(decodeNmdFrontmatterV2Sync(frontmatterV2({ source: 'remote' })).notion_md.source).toBe(
      'remote',
    )
  })

  it('allows an unbound (page_id: null) local file (create-on-push)', () => {
    const decoded = decodeNmdFrontmatterV2Sync(frontmatterV2({ source: 'local', page_id: null }))
    expect(decoded.notion_md.page_id).toBeNull()
  })

  it('rejects source: remote with no page_id', () => {
    expect(() =>
      decodeNmdFrontmatterV2Sync(frontmatterV2({ source: 'remote', page_id: null })),
    ).toThrow()
  })

  it('rejects source: shared with no page_id', () => {
    expect(() =>
      decodeNmdFrontmatterV2Sync(frontmatterV2({ source: 'shared', page_id: null })),
    ).toThrow()
  })

  it('rejects an unknown source value', () => {
    expect(() => decodeNmdFrontmatterV2Sync(frontmatterV2({ source: 'mirror' }))).toThrow()
  })
})

describe('gateNmdLocalState — statelessness gate (R31/R32)', () => {
  it('local + no sidecar (bound) → local-bound', () => {
    const fm = decodeNmdFrontmatterV2Sync(frontmatterV2({ source: 'local' }))
    const gated = gateNmdLocalState({ frontmatter: fm, syncState: undefined })
    expect(gated).toMatchObject({ _tag: 'local-bound', pageId })
  })

  it('local + no sidecar (unbound) → local-unbound', () => {
    const fm = decodeNmdFrontmatterV2Sync(frontmatterV2({ source: 'local', page_id: null }))
    const gated = gateNmdLocalState({ frontmatter: fm, syncState: undefined })
    expect(gated).toMatchObject({ _tag: 'local-unbound' })
  })

  it('remote + no sidecar → remote', () => {
    const fm = decodeNmdFrontmatterV2Sync(frontmatterV2({ source: 'remote' }))
    const gated = gateNmdLocalState({ frontmatter: fm, syncState: undefined })
    expect(gated).toMatchObject({ _tag: 'remote', pageId })
  })

  it('REJECTS a stored base on source: local (poisoned-noop class unreachable)', () => {
    const fm = decodeNmdFrontmatterV2Sync(frontmatterV2({ source: 'local' }))
    const gated = gateNmdLocalState({ frontmatter: fm, syncState })
    expect(gated).toBeInstanceOf(NmdStatelessnessError)
  })

  it('REJECTS a stored base on source: remote', () => {
    const fm = decodeNmdFrontmatterV2Sync(frontmatterV2({ source: 'remote' }))
    const gated = gateNmdLocalState({ frontmatter: fm, syncState })
    expect(gated).toBeInstanceOf(NmdStatelessnessError)
  })

  it('shared + sidecar → shared-bound (the only branch exposing a base)', () => {
    const fm = decodeNmdFrontmatterV2Sync(frontmatterV2({ source: 'shared' }))
    const gated = gateNmdLocalState({ frontmatter: fm, syncState })
    expect(gated).toMatchObject({ _tag: 'shared-bound', pageId })
    if (!(gated instanceof NmdStatelessnessError) && gated._tag === 'shared-bound') {
      expect(gated.syncState.body.base.role).toBe('base_snapshot')
    }
  })

  it('REQUIRES a base for a bound source: shared', () => {
    const fm = decodeNmdFrontmatterV2Sync(frontmatterV2({ source: 'shared' }))
    const gated = gateNmdLocalState({ frontmatter: fm, syncState: undefined })
    expect(gated).toBeInstanceOf(NmdStatelessnessError)
  })
})
