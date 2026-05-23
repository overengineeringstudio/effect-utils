import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NmdFrontmatterV1 } from '@overeng/notion-effect-client'

import { parseNmdFile, renderNmdFile } from './frontmatter.ts'

const pageId = '00000000-0000-4000-8000-000000000001'
const hash = `sha256:${'a'.repeat(64)}` as const

const frontmatter: NmdFrontmatterV1 = {
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
    storage: {
      _tag: 'self_contained',
      unsupported_blocks: [],
      files: [],
      comments: [],
    },
  },
}

const parse = (content: string) => Effect.runPromise(parseNmdFile({ path: 'probe.nmd', content }))

describe('notion-md frontmatter parsing', () => {
  it('normalizes CRLF files into canonical Markdown bodies', async () => {
    const content = renderNmdFile({ frontmatter, body: '# Probe\r\n\r\nBody' }).replaceAll(
      '\n',
      '\r\n',
    )

    await expect(parse(content)).resolves.toMatchObject({
      body: '# Probe\n\nBody\n',
    })
  })

  it('rejects missing frontmatter markers', async () => {
    await expect(parse('# Probe\n\nBody')).rejects.toThrow(
      'Failed to parse strict .nmd frontmatter',
    )
  })

  it('rejects excess frontmatter properties', async () => {
    const content = renderNmdFile({ frontmatter, body: '# Probe\n\nBody' }).replace(
      '"notion_md":',
      '"extra": true,\n  "notion_md":',
    )

    await expect(parse(content)).rejects.toThrow('Failed to parse strict .nmd frontmatter')
  })
})
