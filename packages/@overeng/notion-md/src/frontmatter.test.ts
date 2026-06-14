import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NmdFrontmatterV2 } from '@overeng/notion-effect-client'
import { PropertyDescriptors } from '@overeng/notion-effect-schema'

import { parseNmdFile, renderNmdFile } from './frontmatter.ts'

const pageId = '00000000-0000-4000-8000-000000000001'
const dataSourceId = '00000000-0000-4000-8000-000000000010'
const configHash = `sha256:${'b'.repeat(64)}`

const frontmatter: NmdFrontmatterV2 = {
  notion_md: {
    version: 2,
    api_version: '2026-03-11',
    object: 'page',
    source: 'local',
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

/** Decoded via the shared strict decoder so keys carry the PropertyName brand. */
const descriptors = Schema.decodeUnknownSync(PropertyDescriptors, { onExcessProperty: 'error' })({
  Status: {
    property_id: 'prop_status_abc',
    property_name: 'Status',
    property_type: 'select',
    data_source_id: dataSourceId,
    config_hash: configHash,
  },
})

const frontmatterWithDescriptors: NmdFrontmatterV2 = {
  notion_md: {
    version: 2,
    api_version: '2026-03-11',
    object: 'page',
    source: 'shared',
    page_id: pageId,
    parent: { _tag: 'data_source', id: dataSourceId },
    page: {
      title: 'Datasource page',
      icon: null,
      cover: null,
      in_trash: false,
      is_locked: false,
    },
    properties: {},
    property_descriptors: descriptors,
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

describe('notion-md frontmatter — property_descriptors standalone validity (R03)', () => {
  it('descriptor-bearing .nmd round-trips via the standalone parse path', async () => {
    const body = '# Datasource page\n\nBody content.\n'
    const content = renderNmdFile({ frontmatter: frontmatterWithDescriptors, body })
    const parsed = await parse(content)

    const statusDescriptor = Object.values(
      parsed.frontmatter.notion_md.property_descriptors ?? {},
    )[0]
    expect(statusDescriptor?.property_id).toBe('prop_status_abc')
    expect(statusDescriptor?.property_type).toBe('select')
    expect(parsed.body).toBe(body)
  })

  it('descriptor-free .nmd round-trips via the standalone parse path', async () => {
    const body = '# Standalone page\n\nBody content.\n'
    const content = renderNmdFile({ frontmatter, body })
    const parsed = await parse(content)

    expect(parsed.frontmatter.notion_md.property_descriptors).toBeUndefined()
    expect(parsed.body).toBe(body)
  })

  it('rendered descriptor-bearing file omits property_descriptors for standalone frontmatter', () => {
    const content = renderNmdFile({ frontmatter, body: 'body\n' })
    const parsed = JSON.parse(content.slice(4, content.indexOf('\n---\n', 4)))
    expect(Object.keys(parsed.notion_md)).not.toContain('property_descriptors')
  })

  it('rendered descriptor-bearing file includes property_descriptors for datasource frontmatter', () => {
    const content = renderNmdFile({ frontmatter: frontmatterWithDescriptors, body: 'body\n' })
    const parsed = JSON.parse(content.slice(4, content.indexOf('\n---\n', 4)))
    expect(parsed.notion_md).toHaveProperty('property_descriptors')
    expect(parsed.notion_md.property_descriptors['Status'].property_id).toBe('prop_status_abc')
  })

  it('rejects unknown field inside a descriptor via the standalone parse path (fail-closed)', async () => {
    const content = renderNmdFile({ frontmatter: frontmatterWithDescriptors, body: 'body\n' })
    const tampered = content.replace(
      '"config_hash"',
      '"settlement_proof": "injected",\n          "config_hash"',
    )
    await expect(parse(tampered)).rejects.toThrow('Failed to parse strict .nmd frontmatter')
  })
})
