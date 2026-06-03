import { describe, expect, it } from 'vitest'

import {
  compareNotionApiVersions,
  isNotionApiVersion,
  isSupportedNotionApiVersion,
  NOTION_API_BASE_URL,
  NOTION_API_VERSION,
  NOTION_DOCS_BASE,
  parseNotionApiVersion,
  resolveDocsUrl,
} from './constants.ts'

describe('Notion constants', () => {
  it('exports the current API endpoints and docs base', () => {
    expect(NOTION_API_VERSION).toBe('2026-03-11')
    expect(NOTION_API_BASE_URL).toBe('https://api.notion.com/v1')
    expect(NOTION_DOCS_BASE).toBe('https://developers.notion.com/reference')
  })

  it('resolves docs paths without duplicating slashes', () => {
    expect(resolveDocsUrl('property-value-object#title')).toBe(
      'https://developers.notion.com/reference/property-value-object#title',
    )
    expect(resolveDocsUrl('/rich-text')).toBe('https://developers.notion.com/reference/rich-text')
    expect(resolveDocsUrl('')).toBe('https://developers.notion.com/reference')
  })

  it('leaves already resolved docs URLs untouched', () => {
    expect(resolveDocsUrl('https://developers.notion.com/reference/page')).toBe(
      'https://developers.notion.com/reference/page',
    )
  })
})

describe('Notion API version helpers', () => {
  it('parses valid YYYY-MM-DD API versions', () => {
    expect(parseNotionApiVersion('2026-03-11')).toEqual({
      value: '2026-03-11',
      year: 2026,
      month: 3,
      day: 11,
    })
    expect(isNotionApiVersion('2024-02-29')).toBe(true)
  })

  it('rejects malformed or impossible API versions', () => {
    expect(parseNotionApiVersion('2026-3-11')).toBeUndefined()
    expect(parseNotionApiVersion('2026-13-11')).toBeUndefined()
    expect(parseNotionApiVersion('2025-02-29')).toBeUndefined()
  })

  it('compares valid API version dates', () => {
    expect(compareNotionApiVersions('2026-03-10', '2026-03-11')).toBe(-1)
    expect(compareNotionApiVersions('2026-03-11', '2026-03-11')).toBe(0)
    expect(compareNotionApiVersions('2026-04-01', '2026-03-11')).toBe(1)
    expect(compareNotionApiVersions('invalid', '2026-03-11')).toBeUndefined()
  })

  it('checks the pinned supported API version', () => {
    expect(isSupportedNotionApiVersion(NOTION_API_VERSION)).toBe(true)
    expect(isSupportedNotionApiVersion('2025-09-03')).toBe(false)
  })
})
