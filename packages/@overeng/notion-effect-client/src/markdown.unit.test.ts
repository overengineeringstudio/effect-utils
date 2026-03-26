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
  markdownToBlocks,
  parseInlineMarkdown,
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
        caption: [
          {
            type: 'text',
            text: { content: 'My image' },
            plain_text: 'My image',
          },
        ],
      })
      const result = getBlockCaption(block)
      expect(result).toHaveLength(1)
      expect(result[0]).toHaveProperty('plain_text', 'My image')
    })

    it('returns empty array when no caption', () => {
      const block = mockBlock('image', {
        type: 'external',
        external: { url: 'https://x.com' },
      })
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
      const block = mockBlock('embed', {
        url: 'https://youtube.com/watch?v=abc',
      })
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
      const block = mockBlock('code', {
        language: 'typescript',
        rich_text: [],
      })
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

describe('parseInlineMarkdown', () => {
  it('handles bold', () => {
    const result = parseInlineMarkdown('hello **world**')
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "text": {
            "content": "hello ",
          },
          "type": "text",
        },
        {
          "annotations": {
            "bold": true,
          },
          "text": {
            "content": "world",
          },
          "type": "text",
        },
      ]
    `)
  })

  it('handles italic', () => {
    const result = parseInlineMarkdown('hello *world*')
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "text": {
            "content": "hello ",
          },
          "type": "text",
        },
        {
          "annotations": {
            "italic": true,
          },
          "text": {
            "content": "world",
          },
          "type": "text",
        },
      ]
    `)
  })

  it('handles mixed bold and italic', () => {
    const result = parseInlineMarkdown('**bold** and *italic*')
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "annotations": {
            "bold": true,
          },
          "text": {
            "content": "bold",
          },
          "type": "text",
        },
        {
          "text": {
            "content": " and ",
          },
          "type": "text",
        },
        {
          "annotations": {
            "italic": true,
          },
          "text": {
            "content": "italic",
          },
          "type": "text",
        },
      ]
    `)
  })

  it('returns plain text when no markdown', () => {
    const result = parseInlineMarkdown('plain text')
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "text": {
            "content": "plain text",
          },
          "type": "text",
        },
      ]
    `)
  })
})

describe('markdownToBlocks', () => {
  it('converts headings', () => {
    const blocks = markdownToBlocks('# H1\n\n## H2\n\n### H3')
    expect(blocks).toMatchInlineSnapshot(`
      [
        {
          "heading_1": {
            "rich_text": [
              {
                "text": {
                  "content": "H1",
                },
                "type": "text",
              },
            ],
          },
          "type": "heading_1",
        },
        {
          "heading_2": {
            "rich_text": [
              {
                "text": {
                  "content": "H2",
                },
                "type": "text",
              },
            ],
          },
          "type": "heading_2",
        },
        {
          "heading_3": {
            "rich_text": [
              {
                "text": {
                  "content": "H3",
                },
                "type": "text",
              },
            ],
          },
          "type": "heading_3",
        },
      ]
    `)
  })

  it('converts bullet lists', () => {
    const blocks = markdownToBlocks('- item one\n- item two')
    expect(blocks).toMatchInlineSnapshot(`
      [
        {
          "bulleted_list_item": {
            "rich_text": [
              {
                "text": {
                  "content": "item one",
                },
                "type": "text",
              },
            ],
          },
          "type": "bulleted_list_item",
        },
        {
          "bulleted_list_item": {
            "rich_text": [
              {
                "text": {
                  "content": "item two",
                },
                "type": "text",
              },
            ],
          },
          "type": "bulleted_list_item",
        },
      ]
    `)
  })

  it('converts numbered lists', () => {
    const blocks = markdownToBlocks('1. first\n2. second')
    expect(blocks).toMatchInlineSnapshot(`
      [
        {
          "numbered_list_item": {
            "rich_text": [
              {
                "text": {
                  "content": "first",
                },
                "type": "text",
              },
            ],
          },
          "type": "numbered_list_item",
        },
        {
          "numbered_list_item": {
            "rich_text": [
              {
                "text": {
                  "content": "second",
                },
                "type": "text",
              },
            ],
          },
          "type": "numbered_list_item",
        },
      ]
    `)
  })

  it('converts dividers', () => {
    const blocks = markdownToBlocks('---')
    expect(blocks).toMatchInlineSnapshot(`
      [
        {
          "divider": {},
          "type": "divider",
        },
      ]
    `)
  })

  it('converts simple tables', () => {
    const blocks = markdownToBlocks('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(blocks).toMatchInlineSnapshot(`
      [
        {
          "table": {
            "children": [
              {
                "table_row": {
                  "cells": [
                    [
                      {
                        "text": {
                          "content": "A",
                        },
                        "type": "text",
                      },
                    ],
                    [
                      {
                        "text": {
                          "content": "B",
                        },
                        "type": "text",
                      },
                    ],
                  ],
                },
                "type": "table_row",
              },
              {
                "table_row": {
                  "cells": [
                    [
                      {
                        "text": {
                          "content": "1",
                        },
                        "type": "text",
                      },
                    ],
                    [
                      {
                        "text": {
                          "content": "2",
                        },
                        "type": "text",
                      },
                    ],
                  ],
                },
                "type": "table_row",
              },
            ],
            "has_column_header": true,
            "has_row_header": false,
            "table_width": 2,
          },
          "type": "table",
        },
      ]
    `)
  })

  it('converts tables with bold cells', () => {
    const blocks = markdownToBlocks('| **Name** | Value |\n|---|---|\n| **A** | 1 |')
    const table = blocks[0] as { table: { children: Array<{ table_row: { cells: unknown[][] } }> } }
    const headerCells = table.table.children[0]!.table_row.cells
    expect(headerCells[0]).toMatchInlineSnapshot(`
      [
        {
          "annotations": {
            "bold": true,
          },
          "text": {
            "content": "Name",
          },
          "type": "text",
        },
      ]
    `)
  })

  it('handles large table (HEP Solar portfolio)', () => {
    const md = [
      '| Projekt | Leistung | Standort |',
      '|---|---|---|',
      '| Solar Park A | 10 MW | Bayern |',
      '| Solar Park B | 25 MW | NRW |',
      '| Solar Park C | 15 MW | Sachsen |',
      '| Solar Park D | 30 MW | Brandenburg |',
      '| Solar Park E | 20 MW | Hessen |',
    ].join('\n')
    const blocks = markdownToBlocks(md)
    expect(blocks).toHaveLength(1)
    const table = blocks[0] as { table: { children: unknown[]; table_width: number } }
    expect(table.table.table_width).toBe(3)
    expect(table.table.children).toHaveLength(6) // 1 header + 5 data rows
  })

  it('handles alignment markers in tables', () => {
    const md = '| Left | Center | Right |\n|:---|:---:|---:|\n| a | b | c |'
    const blocks = markdownToBlocks(md)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toHaveProperty('type', 'table')
  })

  it('falls back to paragraph for non-table pipe content', () => {
    const blocks = markdownToBlocks('this | is | not a table')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toHaveProperty('type', 'paragraph')
  })

  it('pads missing cells to table width', () => {
    const md = '| A | B | C |\n|---|---|---|\n| 1 |'
    const blocks = markdownToBlocks(md)
    const table = blocks[0] as { table: { children: Array<{ table_row: { cells: unknown[][] } }> } }
    const dataRow = table.table.children[1]!.table_row.cells
    expect(dataRow).toHaveLength(3)
    // Missing cells should get empty string content
    expect(dataRow[1]).toMatchInlineSnapshot(`
      [
        {
          "text": {
            "content": "",
          },
          "type": "text",
        },
      ]
    `)
  })

  it('handles mixed headings + tables + paragraphs', () => {
    const md = '# Title\n\nSome text here.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n## Section'
    const blocks = markdownToBlocks(md)
    expect(blocks.map((b) => b.type)).toMatchInlineSnapshot(`
      [
        "heading_1",
        "paragraph",
        "table",
        "heading_2",
      ]
    `)
  })

  it('normalizes <br> before parsing', () => {
    const blocks = markdownToBlocks('line1<br>line2<br/>line3')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toHaveProperty('type', 'paragraph')
    const para = blocks[0] as { paragraph: { rich_text: Array<{ text: { content: string } }> } }
    expect(para.paragraph.rich_text[0]!.text.content).toBe('line1\nline2\nline3')
  })

  it('splits inline block markers within paragraphs', () => {
    const blocks = markdownToBlocks('some text\n# Heading')
    expect(blocks.map((b) => b.type)).toMatchInlineSnapshot(`
      [
        "paragraph",
        "heading_1",
      ]
    `)
  })
})
