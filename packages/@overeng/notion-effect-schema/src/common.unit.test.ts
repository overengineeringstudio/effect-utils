import { describe, expect, it } from 'vitest'

import { compactNotionUuid, formatNotionUuid, notionObjectUrl, parseNotionUuid } from './common.ts'

const dashed = '01234567-89ab-cdef-0123-456789abcdef'
const compact = '0123456789abcdef0123456789abcdef'

describe('Notion ID helpers', () => {
  it('normalizes compact and dashed IDs', () => {
    expect(compactNotionUuid(dashed)).toBe(compact)
    expect(formatNotionUuid(compact)).toBe(dashed)
    expect(parseNotionUuid(compact)).toBe(dashed)
    expect(parseNotionUuid(dashed)).toBe(dashed)
  })

  it('extracts object IDs from Notion URLs', () => {
    expect(
      parseNotionUuid(
        'https://www.notion.so/example/0123456789abcdef0123456789abcdef?v=feedfacefeedfacefeedfacefeedface',
      ),
    ).toBe(dashed)
  })

  it('builds compact object URLs', () => {
    expect(notionObjectUrl(dashed)).toBe(`https://notion.so/${compact}`)
  })
})
