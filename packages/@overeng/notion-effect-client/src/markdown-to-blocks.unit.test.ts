import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import { markdownToBlocks } from './markdown-to-blocks.ts'

const block = (markdown: string, index = 0) =>
  markdownToBlocks(markdown)[index] as Record<string, unknown>

describe('markdownToBlocks', () => {
  it('converts paragraphs and normalizes HTML line breaks within paragraph text', () => {
    expect(markdownToBlocks('one<br>two')).toEqual([
      {
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: 'one\ntwo' } }],
        },
      },
    ])
  })

  it('uses normalized HTML line breaks to split adjacent block starts', () => {
    expect(markdownToBlocks('## Acme<br>### Growth').map((item) => item.type)).toEqual([
      'heading_2',
      'heading_3',
    ])
  })

  it('converts headings and caps deeper headings at Notion heading_3', () => {
    expect(markdownToBlocks('# One\n\n## Two\n\n#### Four').map((item) => item.type)).toEqual([
      'heading_1',
      'heading_2',
      'heading_3',
    ])
  })

  it('converts thematic breaks to dividers', () => {
    expect(markdownToBlocks('---')).toEqual([{ type: 'divider', divider: {} }])
  })

  it('converts inline rich text marks', () => {
    const paragraph = block('**bold** *italic* `code` ~~gone~~') as {
      readonly paragraph: { readonly rich_text: readonly unknown[] }
    }

    expect(paragraph.paragraph.rich_text).toEqual([
      { type: 'text', text: { content: 'bold' }, annotations: { bold: true } },
      { type: 'text', text: { content: ' ' } },
      { type: 'text', text: { content: 'italic' }, annotations: { italic: true } },
      { type: 'text', text: { content: ' ' } },
      { type: 'text', text: { content: 'code' }, annotations: { code: true } },
      { type: 'text', text: { content: ' ' } },
      { type: 'text', text: { content: 'gone' }, annotations: { strikethrough: true } },
    ])
  })

  it('preserves explicit markdown links in rich text', () => {
    const paragraph = block('[Example](https://example.com)') as {
      readonly paragraph: { readonly rich_text: readonly unknown[] }
    }

    expect(paragraph.paragraph.rich_text).toEqual([
      {
        type: 'text',
        text: { content: 'Example', link: { url: 'https://example.com' } },
      },
    ])
  })

  it('expands bullet, ordered, and task-list items to appendable blocks', () => {
    expect(
      markdownToBlocks('- a\n- **b**\n\n1. one\n2. two\n\n- [x] done').map((item) => item.type),
    ).toEqual([
      'bulleted_list_item',
      'bulleted_list_item',
      'numbered_list_item',
      'numbered_list_item',
      'to_do',
    ])
  })

  it('converts GFM tables with rich text cells', () => {
    const table = block('| Item | Amount |\n|---|---|\n| **Total** | *1.309,00 EUR* |') as {
      readonly table: {
        readonly table_width: number
        readonly has_column_header: boolean
        readonly has_row_header: boolean
        readonly children: ReadonlyArray<{
          readonly table_row: { readonly cells: readonly (readonly unknown[])[] }
        }>
      }
    }

    expect(table.table.table_width).toBe(2)
    expect(table.table.has_column_header).toBe(true)
    expect(table.table.has_row_header).toBe(false)
    expect(table.table.children).toHaveLength(2)
    expect(table.table.children[1]?.table_row.cells[0]).toEqual([
      { type: 'text', text: { content: 'Total' }, annotations: { bold: true } },
    ])
    expect(table.table.children[1]?.table_row.cells[1]).toEqual([
      { type: 'text', text: { content: '1.309,00 EUR' }, annotations: { italic: true } },
    ])
  })

  it('pads missing table cells to the table width', () => {
    const table = block('| A | B | C |\n|---|---|---|\n| 1 |') as {
      readonly table: {
        readonly table_width: number
        readonly children: ReadonlyArray<{
          readonly table_row: { readonly cells: readonly (readonly unknown[])[] }
        }>
      }
    }

    expect(table.table.table_width).toBe(3)
    expect(table.table.children[1]?.table_row.cells).toHaveLength(3)
    expect(table.table.children[1]?.table_row.cells[2]).toEqual([
      { type: 'text', text: { content: '' } },
    ])
  })

  it('leaves non-table pipe content as a paragraph', () => {
    expect(markdownToBlocks('acme | 123 Main St | 90210 Springfield')).toEqual([
      {
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: 'acme | 123 Main St | 90210 Springfield' } },
          ],
        },
      },
    ])
  })

  it('converts mixed heading, table, and paragraph content in order', () => {
    expect(
      markdownToBlocks(
        '## Balance\n\n| Item | Amount |\n|---|---|\n| Assets | 63.087 |\n\nText after table.',
      ).map((item) => item.type),
    ).toEqual(['heading_2', 'table', 'paragraph'])
  })
})
