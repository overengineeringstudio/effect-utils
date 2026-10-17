import { describe, expect, it } from 'vitest'

import { compactNotionUuid, formatNotionUuid, notionObjectUrl, parseNotionUuid } from './ids.ts'

const dashed = '01234567-89ab-cdef-0123-456789abcdef'
const compact = '0123456789abcdef0123456789abcdef'

describe('Notion ID helpers', () => {
  it('normalizes compact and dashed IDs', () => {
    expect(compactNotionUuid(dashed)).toBe(compact)
    expect(formatNotionUuid(compact)).toBe(dashed)
    expect(parseNotionUuid(compact)).toBe(dashed)
    expect(parseNotionUuid(dashed)).toBe(dashed)
  })

  it('normalizes uppercase IDs to canonical lowercase UUIDs', () => {
    expect(parseNotionUuid('0123456789ABCDEF0123456789ABCDEF')).toBe(dashed)
  })

  it('extracts object IDs from Notion URLs', () => {
    expect(
      parseNotionUuid(
        'https://www.notion.so/example/0123456789abcdef0123456789abcdef?v=feedfacefeedfacefeedfacefeedface',
      ),
    ).toBe(dashed)
  })

  it('extracts dashed IDs embedded in URLs', () => {
    expect(parseNotionUuid(`https://www.notion.so/${dashed}`)).toBe(dashed)
  })

  it('rejects invalid UUID-like values', () => {
    expect(formatNotionUuid('not-an-id')).toBeUndefined()
    expect(parseNotionUuid('')).toBeUndefined()
    expect(parseNotionUuid('not-an-id')).toBeUndefined()
  })

  it('builds compact object URLs', () => {
    expect(notionObjectUrl(dashed)).toBe(`https://notion.so/${compact}`)
    expect(notionObjectUrl(`https://www.notion.so/${dashed}`)).toBe(`https://notion.so/${compact}`)
  })
})
