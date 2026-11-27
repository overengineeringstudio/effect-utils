import { BlockSchema } from '@overeng/notion-effect-schema'
import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { markdownToBlocks, type NotionBlockCreate } from './markdown-to-blocks.ts'
import type { BlockTreeNode } from './blocks.ts'
import type { NotionTableRowBlockCreate } from './markdown-to-blocks.ts'
import { treeToMarkdown } from './markdown.ts'
import { NotionMarkdown } from './markdown.ts'

const table = (block: NotionBlockCreate | undefined) => {
  expect(block?.type).toBe('table')
  if (block?.type !== 'table') throw new Error('Expected table block')
  return block.table
}

/** Supply server-owned metadata at the create/read boundary used by the renderer. */
const readTree = (block: NotionBlockCreate | NotionTableRowBlockCreate): BlockTreeNode => {
  const content = Object.entries(block).find(([key]) => key === block.type)?.[1]
  const children = block.type === 'table' ? block.table.children :
    block.type === 'callout' ? block.callout.children ?? [] :
    block.type === 'toggle' ? block.toggle.children ?? [] :
    block.type === 'quote' ? block.quote.children ?? [] :
    block.type === 'bulleted_list_item' ? block.bulleted_list_item.children ?? [] :
    block.type === 'numbered_list_item' ? block.numbered_list_item.children ?? [] :
    block.type === 'to_do' ? block.to_do.children ?? [] : []
  const hydrateRichText = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(hydrateRichText)
    if (typeof value !== 'object' || value === null) return value
    const fields = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrateRichText(item)]))
    if (fields.type === 'text' || fields.type === 'mention') {
      return { ...fields,
        plain_text: fields.type === 'mention' ? 'Reference' :
          typeof fields.text === 'object' && fields.text !== null && 'content' in fields.text ? fields.text.content : '',
        href: null,
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default',
          ...(typeof fields.annotations === 'object' ? fields.annotations : {}) },
      }
    }
    return fields
  }
  const id = '12345678-1234-1234-1234-123456789abc'
  return {
    block: Schema.decodeSync(BlockSchema)({
      ...block, [block.type]: hydrateRichText(content),
      id, has_children: children.length > 0, in_trash: false,
      created_time: '2026-11-27T00:00:00.000Z', last_edited_time: '2026-11-27T00:00:00.000Z',
      created_by: { object: 'user', id }, last_edited_by: { object: 'user', id },
      parent: { type: 'page_id', page_id: id },
    }),
    children: children.map(readTree),
  }
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
    expect(block.children[0]?.table_row.cells[0]?.[0]).toHaveProperty('text.content', 'Name')
    expect(block.children[2]?.table_row.cells[1]?.[0]).toHaveProperty('text.content', '2')
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
    expect(block.children[1]?.table_row.cells[2]?.[0]).toHaveProperty('text.content', '')
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

  it('preserves enhanced callout icon, color, rich text, and nested blocks', () => {
    const blocks = markdownToBlocks([
      '<callout icon="💡" color="blue_bg">',
      '\t**Tip** &amp; details',
      '',
      '\t<details color="green">',
      '\t<summary>More</summary>',
      '\t\tNested content',
      '\t</details>',
      '</callout>',
      '',
      'After',
    ].join('\n'))
    expect(blocks).toMatchObject([
      { type: 'callout', callout: {
        icon: { type: 'emoji', emoji: '💡' }, color: 'blue_background',
        rich_text: [{ text: { content: 'Tip' }, annotations: { bold: true } }, { text: { content: ' & details' } }],
        children: [{ type: 'toggle', toggle: {
          color: 'green', rich_text: [{ text: { content: 'More' } }],
          children: [{ type: 'paragraph', paragraph: { rich_text: [{ text: { content: 'Nested content' } }] } }],
        } }],
      } },
      { type: 'paragraph', paragraph: { rich_text: [{ text: { content: 'After' } }] } },
    ])
  })

  it('preserves enhanced table header flags and rich cells without pipe splitting', () => {
    const block = table(markdownToBlocks([
      '<table header-row="true" header-column="true">',
      '\t<tr>',
      '\t\t<td>**Header**</td>',
      '\t\t<td>A | B &amp; C</td>',
      '\t</tr>',
      '',
      '\t<tr>',
      '\t\t<td>Value</td>',
      '\t\t<td>`a|b`</td>',
      '\t</tr>',
      '</table>',
    ].join('\n'))[0])
    expect(block).toMatchObject({ table_width: 2, has_column_header: true, has_row_header: true })
    expect(block.children[0]?.table_row.cells).toEqual([
      [{ type: 'text', text: { content: 'Header' }, annotations: { bold: true } }],
      [{ type: 'text', text: { content: 'A | B & C' } }],
    ])
    expect(block.children[1]?.table_row.cells[1]).toEqual([
      { type: 'text', text: { content: 'a|b' }, annotations: { code: true } },
    ])
  })

  it('preserves page, database, user, and timed date mention identities', () => {
    const id = '12345678-1234-1234-1234-123456789abc'
    const blocks = markdownToBlocks([
      `See **<mention-page url="https://www.notion.so/${id}">Page</mention-page>**`,
      `and <mention-database url="https://www.notion.so/${id}">DB</mention-database>`,
      `with <mention-user url="${id}">Person</mention-user>`,
      '<mention-date start="2026-11-27T10:00:00" end="2026-11-27T11:00:00" timeZone="Europe/Berlin"/>.',
    ].join(' '))
    expect(blocks[0]).toMatchObject({ paragraph: { rich_text: [
      { text: { content: 'See ' } },
      { type: 'mention', mention: { type: 'page', page: { id } }, annotations: { bold: true } },
      { text: { content: ' and ' } },
      { type: 'mention', mention: { type: 'database', database: { id } } },
      { text: { content: ' with ' } },
      { type: 'mention', mention: { type: 'user', user: { object: 'user', id } } },
      { text: { content: ' ' } },
      { type: 'mention', mention: { type: 'date', date: {
        start: '2026-11-27T10:00:00', end: '2026-11-27T11:00:00', time_zone: 'Europe/Berlin',
      } } },
      { text: { content: '.' } },
    ] } })
    expect(markdownToBlocks(`<mention-page url="https://www.notion.so/${id}">Page</mention-page>`)[0])
      .toMatchObject({ type: 'paragraph', paragraph: { rich_text: [{ type: 'mention', mention: { type: 'page', page: { id } } }] } })
  })

  it('does not parse enhanced tags inside code fences or inline code', () => {
    expect(markdownToBlocks('```html\n<callout icon="💡">Literal</callout>\n```')[0])
      .toMatchObject({ type: 'code' })
    expect(markdownToBlocks('<callout>\n\tLiteral `</callout>` text\n</callout>')[0])
      .toMatchObject({ type: 'callout', callout: { rich_text: [
        { text: { content: 'Literal ' } },
        { text: { content: '</callout>' }, annotations: { code: true } },
        { text: { content: ' text' } },
      ] } })
  })

  it.each([
    ['callout', '<callout icon="💡" color="blue_bg">\n\tTip\n\n\tChild\n</callout>'],
    ['table', '<table header-row="true" header-column="true">\n\t<tr>\n\t\t<td>Header</td>\n\t\t<td>Value</td>\n\t</tr>\n\n\t<tr>\n\t\t<td>Row</td>\n\t\t<td>Cell</td>\n\t</tr>\n</table>'],
    ['toggle', '<details color="green">\n<summary>More</summary>\n\tChild\n</details>'],
    ['mentions', 'See <mention-page url="https://notion.so/12345678123412341234123456789abc">Reference</mention-page> and <mention-user url="12345678-1234-1234-1234-123456789abc">Reference</mention-user> on <mention-date start="2026-11-27T10:00:00" end="2026-11-27T11:00:00" timeZone="Europe/Berlin"/>.'],
  ])('round-trips enhanced %s through the live tree renderer', async (_family, markdown) => {
    const tree = markdownToBlocks(markdown).map(readTree)
    expect(await Effect.runPromise(treeToMarkdown({ tree }))).toBe(markdown)
  })
})
