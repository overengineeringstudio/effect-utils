import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NmdFrontmatterV2 } from '@overeng/notion-effect-client'

import { parseNmdFile, renderNmdFile } from './frontmatter.ts'

const pageId = '00000000-0000-4000-8000-000000000001'

const frontmatter: NmdFrontmatterV2 = {
  notion_md: {
    version: 2,
    api_version: '2026-03-11',
    object: 'page',
    page_id: pageId,
    url: 'https://www.notion.so/test',
    parent: { _tag: 'page', id: pageId },
    page: {
      title: 'Probe',
      icon: null,
      cover: null,
      in_trash: false,
      is_locked: false,
    },
    properties: {},
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
