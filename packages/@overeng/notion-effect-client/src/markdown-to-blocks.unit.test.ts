import { describe, expect, it } from 'vitest'

import { markdownToBlocks, type NotionBlockCreate } from './markdown-to-blocks.ts'
import { NotionMarkdown } from './markdown.ts'

const table = (block: NotionBlockCreate | undefined) => {
  expect(block?.type).toBe('table')
  if (block?.type !== 'table') throw new Error('Expected table block')
  return block.table
}

describe('markdownToBlocks', () => {
  it('is exposed through NotionMarkdown', () => {
    expect(NotionMarkdown.markdownToBlocks('# Title')[0]?.type).toBe('heading_1')
  })

  it('converts paragraphs, headings, dividers, and bullet lists', () => {
    expect(
      markdownToBlocks(
        ['# Title', '', 'Body **bold** and _italic_.', '', '---', '', '- A', '- B'].join('\n'),
      ),
    ).toEqual([
      {
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: [{ type: 'text', text: { content: 'Title' } }] },
      },
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: 'Body ' } },
            { type: 'text', text: { content: 'bold' }, annotations: { bold: true } },
            { type: 'text', text: { content: ' and ' } },
            { type: 'text', text: { content: 'italic' }, annotations: { italic: true } },
            { type: 'text', text: { content: '.' } },
          ],
        },
      },
      { object: 'block', type: 'divider', divider: {} },
      {
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'A' } }] },
      },
      {
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'B' } }] },
      },
    ])
  })

  it('converts ordered lists, task lists, and nested list children', () => {
    expect(
      markdownToBlocks(
        ['1. First', '2. Second', '', '- [x] Done', '- [ ] Todo', '  - nested'].join('\n'),
      ),
    ).toMatchObject([
      {
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: [{ text: { content: 'First' } }] },
      },
      {
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: [{ text: { content: 'Second' } }] },
      },
      {
        object: 'block',
        type: 'to_do',
        to_do: { checked: true, rich_text: [{ text: { content: 'Done' } }] },
      },
      {
        object: 'block',
        type: 'to_do',
        to_do: {
          checked: false,
          rich_text: [{ text: { content: 'Todo' } }],
          children: [{ object: 'block', type: 'bulleted_list_item' }],
        },
      },
    ])
  })

  it('converts GFM tables into Notion tables with header rows', () => {
    const block = table(markdownToBlocks('| Name | Value |\n|---|---|\n| A | 1 |\n| B | 2 |')[0])

    expect(block.table_width).toBe(2)
    expect(block.has_column_header).toBe(true)
    expect(block.has_row_header).toBe(false)
    expect(block.children).toHaveLength(3)
    expect(block.children[0]?.table_row.cells[0]?.[0]?.text.content).toBe('Name')
    expect(block.children[2]?.table_row.cells[1]?.[0]?.text.content).toBe('2')
  })

  it('preserves rich text inside table cells', () => {
    const block = table(
      markdownToBlocks('| Item | Amount |\n|---|---|\n| **Total** | ~~1~~ `2` |')[0],
    )

    expect(block.children[1]?.table_row.cells[0]?.[0]).toMatchObject({
      text: { content: 'Total' },
      annotations: { bold: true },
    })
    expect(block.children[1]?.table_row.cells[1]?.[0]).toMatchObject({
      text: { content: '1' },
      annotations: { strikethrough: true },
    })
    expect(block.children[1]?.table_row.cells[1]?.[1]).toMatchObject({ text: { content: ' ' } })
    expect(block.children[1]?.table_row.cells[1]?.[2]).toMatchObject({
      text: { content: '2' },
      annotations: { code: true },
    })
  })

  it('handles table alignment markers and pads missing cells', () => {
    const block = table(markdownToBlocks('| A | B | C |\n|:---|:---:|---:|\n| 1 |')[0])

    expect(block.table_width).toBe(3)
    expect(block.children[1]?.table_row.cells).toHaveLength(3)
    expect(block.children[1]?.table_row.cells[2]?.[0]?.text.content).toBe('')
  })

  it('leaves non-table pipe content as a paragraph', () => {
    const blocks = markdownToBlocks('acme | 123 Main St | 90210 Springfield')

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('paragraph')
  })

  it('splits headings separated by HTML break tags', () => {
    const blocks = markdownToBlocks('## Acme Holdings Fund No. 190<br>### Growth Portfolio 48')

    expect(blocks.map((block) => block.type)).toEqual(['heading_2', 'heading_3'])
  })

  it('converts mixed document blocks in source order', () => {
    const blocks = markdownToBlocks(
      [
        '## Balance',
        '',
        '| Item | Amount |',
        '|---|---|',
        '| Assets | 63.087 |',
        '',
        'Text after table.',
      ].join('\n'),
    )

    expect(blocks.map((block) => block.type)).toEqual(['heading_2', 'table', 'paragraph'])
  })

  it('supports links and explicit hard breaks in rich text', () => {
    const blocks = markdownToBlocks('Visit [Example](https://example.com)\\\nnext line')

    expect(blocks[0]).toMatchObject({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { text: { content: 'Visit ' } },
          { text: { content: 'Example', link: { url: 'https://example.com' } } },
          { text: { content: '\n' } },
          { text: { content: 'next line' } },
        ],
      },
    })
  })

  it('collapses Markdown soft breaks without changing explicit hard breaks', () => {
    const blocks = markdownToBlocks('soft\nwrapped\\\nhard')

    expect(blocks[0]).toMatchObject({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { text: { content: 'soft wrapped' } },
          { text: { content: '\n' } },
          { text: { content: 'hard' } },
        ],
      },
    })
  })

  it('converts code blocks and block quotes', () => {
    const blocks = markdownToBlocks(
      ['```ts', 'const x = 1', '```', '', '> note', '> - nested'].join('\n'),
    )

    expect(blocks[0]).toMatchObject({
      object: 'block',
      type: 'code',
      code: { language: 'typescript', rich_text: [{ text: { content: 'const x = 1' } }] },
    })
    expect(blocks[1]).toMatchObject({
      object: 'block',
      type: 'quote',
      quote: {
        rich_text: [{ text: { content: 'note' } }],
        children: [{ object: 'block', type: 'bulleted_list_item' }],
      },
    })
  })

  it('normalizes JavaScript code fence aliases', () => {
    expect(markdownToBlocks('```js\nconst y = 2\n```')[0]).toMatchObject({
      object: 'block',
      type: 'code',
      code: { language: 'javascript' },
    })
  })

  it('preserves loose list item child blocks', () => {
    const blocks = markdownToBlocks(
      ['- first paragraph', '', '  second paragraph', '', '  ```js', '  const x = 1', '  ```'].join(
        '\n',
      ),
    )

    expect(blocks[0]).toMatchObject({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [{ text: { content: 'first paragraph' } }],
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ text: { content: 'second paragraph' } }] },
          },
          {
            object: 'block',
            type: 'code',
            code: {
              language: 'javascript',
              rich_text: [{ text: { content: 'const x = 1' } }],
            },
          },
        ],
      },
    })
  })
})
