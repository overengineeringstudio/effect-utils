import { describe, expect, it } from 'vitest'
import {
  BlockHelpers,
  type BlockWithData,
  getBlockCaption,
  getBlockRichText,
  getBlockUrl,
  getCalloutIcon,
  getChildDatabaseTitle,
  getChildPageTitle,
  getCodeLanguage,
  getEquationExpression,
  getTableRowCells,
  isTodoChecked,
} from './markdown.ts'

/** Create a mock block with specific type data */
const mockBlock = <T extends string>(type: T, data: Record<string, unknown>): BlockWithData =>
  ({
    object: 'block',
    id: 'test-id',
    type,
    has_children: false,
    archived: false,
    in_trash: false,
    created_time: '2025-01-01T00:00:00.000Z',
    last_edited_time: '2025-01-01T00:00:00.000Z',
    created_by: { object: 'user', id: 'user-id' },
    last_edited_by: { object: 'user', id: 'user-id' },
    parent: { type: 'page_id', page_id: 'parent-id' },
    [type]: data,
  }) as BlockWithData

describe('Block Helpers', () => {
  describe('getBlockRichText', () => {
    it('extracts rich text from paragraph block', () => {
      const block = mockBlock('paragraph', {
        rich_text: [{ type: 'text', text: { content: 'Hello' }, plain_text: 'Hello' }],
      })
      const result = getBlockRichText(block)
      expect(result).toHaveLength(1)
      expect(result[0]).toHaveProperty('plain_text', 'Hello')
    })

    it('returns empty array when no rich text', () => {
      const block = mockBlock('paragraph', {})
      expect(getBlockRichText(block)).toEqual([])
    })

    it('is accessible via BlockHelpers namespace', () => {
      const block = mockBlock('heading_1', {
        rich_text: [{ type: 'text', text: { content: 'Title' }, plain_text: 'Title' }],
      })
      const result = BlockHelpers.getRichText(block)
      expect(result[0]).toHaveProperty('plain_text', 'Title')
    })
  })

  describe('getBlockCaption', () => {
    it('extracts caption from image block', () => {
      const block = mockBlock('image', {
        type: 'external',
        external: { url: 'https://example.com/img.png' },
        caption: [{ type: 'text', text: { content: 'My image' }, plain_text: 'My image' }],
      })
      const result = getBlockCaption(block)
      expect(result).toHaveLength(1)
      expect(result[0]).toHaveProperty('plain_text', 'My image')
    })

    it('returns empty array when no caption', () => {
      const block = mockBlock('image', { type: 'external', external: { url: 'https://x.com' } })
      expect(getBlockCaption(block)).toEqual([])
    })

    it('is accessible via BlockHelpers.getCaption', () => {
      const block = mockBlock('video', {
        caption: [{ plain_text: 'Video caption' }],
      })
      expect(BlockHelpers.getCaption(block)[0]).toHaveProperty('plain_text', 'Video caption')
    })
  })

  describe('getBlockUrl', () => {
    it('extracts URL from external image', () => {
      const block = mockBlock('image', {
        type: 'external',
        external: { url: 'https://example.com/img.png' },
      })
      expect(getBlockUrl(block)).toBe('https://example.com/img.png')
    })

    it('extracts URL from Notion-hosted file', () => {
      const block = mockBlock('file', {
        type: 'file',
        file: { url: 'https://s3.notion.so/file.pdf' },
      })
      expect(getBlockUrl(block)).toBe('https://s3.notion.so/file.pdf')
    })

    it('extracts URL from bookmark', () => {
      const block = mockBlock('bookmark', { url: 'https://google.com' })
      expect(getBlockUrl(block)).toBe('https://google.com')
    })

    it('returns undefined when no URL', () => {
      const block = mockBlock('paragraph', { rich_text: [] })
      expect(getBlockUrl(block)).toBeUndefined()
    })

    it('is accessible via BlockHelpers.getUrl', () => {
      const block = mockBlock('embed', { url: 'https://youtube.com/watch?v=abc' })
      expect(BlockHelpers.getUrl(block)).toBe('https://youtube.com/watch?v=abc')
    })
  })

  describe('isTodoChecked', () => {
    it('returns true for checked to-do', () => {
      const block = mockBlock('to_do', { checked: true, rich_text: [] })
      expect(isTodoChecked(block)).toBe(true)
    })

    it('returns false for unchecked to-do', () => {
      const block = mockBlock('to_do', { checked: false, rich_text: [] })
      expect(isTodoChecked(block)).toBe(false)
    })

    it('returns false when checked is undefined', () => {
      const block = mockBlock('to_do', { rich_text: [] })
      expect(isTodoChecked(block)).toBe(false)
    })

    it('is accessible via BlockHelpers.isTodoChecked', () => {
      const block = mockBlock('to_do', { checked: true })
      expect(BlockHelpers.isTodoChecked(block)).toBe(true)
    })
  })

  describe('getCodeLanguage', () => {
    it('extracts language from code block', () => {
      const block = mockBlock('code', { language: 'typescript', rich_text: [] })
      expect(getCodeLanguage(block)).toBe('typescript')
    })

    it('returns empty string when no language', () => {
      const block = mockBlock('code', { rich_text: [] })
      expect(getCodeLanguage(block)).toBe('')
    })

    it('is accessible via BlockHelpers.getCodeLanguage', () => {
      const block = mockBlock('code', { language: 'rust' })
      expect(BlockHelpers.getCodeLanguage(block)).toBe('rust')
    })
  })

  describe('getCalloutIcon', () => {
    it('extracts emoji icon from callout', () => {
      const block = mockBlock('callout', {
        icon: { type: 'emoji', emoji: '💡' },
        rich_text: [],
      })
      expect(getCalloutIcon(block)).toBe('💡')
    })

    it('returns empty string when no icon', () => {
      const block = mockBlock('callout', { rich_text: [] })
      expect(getCalloutIcon(block)).toBe('')
    })

    it('is accessible via BlockHelpers.getCalloutIcon', () => {
      const block = mockBlock('callout', { icon: { emoji: '🔥' } })
      expect(BlockHelpers.getCalloutIcon(block)).toBe('🔥')
    })
  })

  describe('getChildPageTitle', () => {
    it('extracts title from child page', () => {
      const block = mockBlock('child_page', { title: 'My Subpage' })
      expect(getChildPageTitle(block)).toBe('My Subpage')
    })

    it('returns "Untitled" when no title', () => {
      const block = mockBlock('child_page', {})
      expect(getChildPageTitle(block)).toBe('Untitled')
    })

    it('is accessible via BlockHelpers.getChildPageTitle', () => {
      const block = mockBlock('child_page', { title: 'Test' })
      expect(BlockHelpers.getChildPageTitle(block)).toBe('Test')
    })
  })

  describe('getChildDatabaseTitle', () => {
    it('extracts title from child database', () => {
      const block = mockBlock('child_database', { title: 'My Database' })
      expect(getChildDatabaseTitle(block)).toBe('My Database')
    })

    it('returns "Untitled Database" when no title', () => {
      const block = mockBlock('child_database', {})
      expect(getChildDatabaseTitle(block)).toBe('Untitled Database')
    })

    it('is accessible via BlockHelpers.getChildDatabaseTitle', () => {
      const block = mockBlock('child_database', { title: 'Tasks' })
      expect(BlockHelpers.getChildDatabaseTitle(block)).toBe('Tasks')
    })
  })

  describe('getTableRowCells', () => {
    it('extracts cells from table row', () => {
      const block = mockBlock('table_row', {
        cells: [[{ plain_text: 'Cell 1' }], [{ plain_text: 'Cell 2' }]],
      })
      const cells = getTableRowCells(block)
      expect(cells).toHaveLength(2)
      expect(cells[0]?.[0]).toHaveProperty('plain_text', 'Cell 1')
    })

    it('returns empty array when no cells', () => {
      const block = mockBlock('table_row', {})
      expect(getTableRowCells(block)).toEqual([])
    })

    it('is accessible via BlockHelpers.getTableRowCells', () => {
      const block = mockBlock('table_row', { cells: [[{ plain_text: 'A' }]] })
      expect(BlockHelpers.getTableRowCells(block)).toHaveLength(1)
    })
  })

  describe('getEquationExpression', () => {
    it('extracts expression from equation block', () => {
      const block = mockBlock('equation', { expression: 'E = mc^2' })
      expect(getEquationExpression(block)).toBe('E = mc^2')
    })

    it('returns empty string when no expression', () => {
      const block = mockBlock('equation', {})
      expect(getEquationExpression(block)).toBe('')
    })

    it('is accessible via BlockHelpers.getEquationExpression', () => {
      const block = mockBlock('equation', { expression: 'x^2 + y^2 = r^2' })
      expect(BlockHelpers.getEquationExpression(block)).toBe('x^2 + y^2 = r^2')
    })
  })
})
