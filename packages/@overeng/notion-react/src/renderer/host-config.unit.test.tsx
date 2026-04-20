import { describe, expect, it } from 'vitest'

import {
  Breadcrumb,
  BulletedListItem,
  Callout,
  ChildDatabase,
  ChildPage,
  Column,
  ColumnList,
  Heading1,
  Image,
  LinkToPage,
  NumberedListItem,
  Paragraph,
  Pdf,
  Quote,
  Raw,
  SyncedBlock,
  Table,
  TableRow,
  ToDo,
  Toggle,
  Video,
} from '../components/blocks.tsx'
import { Bold } from '../components/inline.tsx'
import { createNotionRoot } from './host-config.ts'
import { OpBuffer } from './op-buffer.ts'

const makeRoot = () => {
  const buffer = new OpBuffer('root')
  const root = createNotionRoot(buffer, 'root')
  return { buffer, root }
}

describe('host-config', () => {
  it('emits append ops for an initial tree', () => {
    const { buffer, root } = makeRoot()
    root.render(
      <>
        <Heading1>Title</Heading1>
        <Paragraph>Hello</Paragraph>
        <Toggle title="more">
          <Paragraph>inner</Paragraph>
        </Toggle>
      </>,
    )
    const kinds = buffer.ops.map((o) => o.kind)
    // 3 top-level appends + 1 nested append under Toggle
    expect(kinds).toEqual(['append', 'append', 'append', 'append'])
    const types = buffer.ops.map((o) => ('type' in o ? o.type : null))
    expect(types).toEqual(['heading_1', 'paragraph', 'toggle', 'paragraph'])
  })

  it('emits an update op when a rich_text child changes', () => {
    const { buffer, root } = makeRoot()
    root.render(<Paragraph>v1</Paragraph>)
    const before = buffer.ops.length
    root.render(<Paragraph>v2</Paragraph>)
    const after = buffer.ops.slice(before)
    expect(after).toHaveLength(1)
    expect(after[0]!.kind).toBe('update')
  })

  it('emits an append op when a sibling is added', () => {
    const { buffer, root } = makeRoot()
    root.render(
      <>
        <Paragraph>a</Paragraph>
      </>,
    )
    const before = buffer.ops.length
    root.render(
      <>
        <Paragraph>a</Paragraph>
        <Paragraph>b</Paragraph>
      </>,
    )
    const after = buffer.ops.slice(before)
    expect(after.map((o) => o.kind)).toEqual(['append'])
  })

  it('emits a remove op when a child is removed', () => {
    const { buffer, root } = makeRoot()
    root.render(
      <>
        <Paragraph>a</Paragraph>
        <Paragraph>b</Paragraph>
      </>,
    )
    const before = buffer.ops.length
    root.render(
      <>
        <Paragraph>a</Paragraph>
      </>,
    )
    const after = buffer.ops.slice(before)
    expect(after.map((o) => o.kind)).toEqual(['remove'])
  })

  it('projects Toggle title as rich_text (Notion API shape)', () => {
    const { buffer, root } = makeRoot()
    root.render(<Toggle title="more" />)
    const op = buffer.ops[0]!
    expect(op.kind).toBe('append')
    if (op.kind !== 'append') return
    expect(op.type).toBe('toggle')
    expect(op.props).not.toHaveProperty('title')
    expect(op.props.rich_text).toEqual([
      {
        type: 'text',
        text: { content: 'more', link: null },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: 'default',
        },
      },
    ])
  })

  it('projects Heading color onto the block payload', () => {
    const { buffer, root } = makeRoot()
    root.render(<Heading1 color="blue_background">Titled</Heading1>)
    const op = buffer.ops[0]!
    expect(op.kind).toBe('append')
    if (op.kind !== 'append') return
    expect(op.type).toBe('heading_1')
    expect(op.props.color).toBe('blue_background')
  })

  it('projects Heading toggleable + color together', () => {
    const { buffer, root } = makeRoot()
    root.render(
      <Heading1 toggleable color="red">
        x
      </Heading1>,
    )
    const op = buffer.ops[0]!
    expect(op.kind).toBe('append')
    if (op.kind !== 'append') return
    expect(op.props.is_toggleable).toBe(true)
    expect(op.props.color).toBe('red')
  })

  it('projects Callout icon as structured emoji (Notion API shape)', () => {
    const { buffer, root } = makeRoot()
    root.render(
      <Callout icon="💡" color="blue_background">
        hi
      </Callout>,
    )
    const op = buffer.ops[0]!
    expect(op.kind).toBe('append')
    if (op.kind !== 'append') return
    expect(op.type).toBe('callout')
    expect(op.props.icon).toEqual({ type: 'emoji', emoji: '💡' })
    expect(op.props.color).toBe('blue_background')
  })

  it('projects bulleted list item rich_text', () => {
    const { buffer, root } = makeRoot()
    root.render(<BulletedListItem>first</BulletedListItem>)
    const op = buffer.ops[0]!
    expect(op.kind).toBe('append')
    if (op.kind !== 'append') return
    expect(op.type).toBe('bulleted_list_item')
    expect(Array.isArray(op.props.rich_text)).toBe(true)
  })

  it.each([
    [
      'bulleted_list_item',
      <BulletedListItem key="b">
        top<Paragraph>nested</Paragraph>
      </BulletedListItem>,
    ],
    [
      'numbered_list_item',
      <NumberedListItem key="n">
        top<Paragraph>nested</Paragraph>
      </NumberedListItem>,
    ],
    [
      'to_do',
      <ToDo key="t" checked={false}>
        top<Paragraph>nested</Paragraph>
      </ToDo>,
    ],
    [
      'callout',
      <Callout key="c" icon="💡">
        top<Paragraph>nested</Paragraph>
      </Callout>,
    ],
    [
      'quote',
      <Quote key="q">
        top<Paragraph>nested</Paragraph>
      </Quote>,
    ],
  ])(
    'nests a paragraph under %s without folding its text into parent rich_text',
    (type, element) => {
      const { buffer, root } = makeRoot()
      root.render(element)
      // Expect parent append + nested paragraph append.
      expect(buffer.ops.map((o) => ('type' in o ? o.type : o.kind))).toEqual([type, 'paragraph'])
      const parent = buffer.ops[0]!
      expect(parent.kind).toBe('append')
      if (parent.kind !== 'append') return
      // Parent's rich_text carries only "top" — not the nested paragraph's text.
      const rt = parent.props.rich_text as Array<{ text: { content: string } }>
      expect(rt.map((r) => r.text.content).join('')).toBe('top')
      const nested = buffer.ops[1]!
      if (nested.kind !== 'append') return
      const nestedRt = nested.props.rich_text as Array<{ text: { content: string } }>
      expect(nestedRt.map((r) => r.text.content).join('')).toBe('nested')
    },
  )

  it('projects Raw content verbatim for arbitrary block types', () => {
    const { buffer, root } = makeRoot()
    root.render(
      <Raw
        type="tab"
        content={{ title: [{ type: 'text', text: { content: 'Tab 1' } }], color: 'default' }}
      />,
    )
    const op = buffer.ops[0]!
    expect(op.kind).toBe('append')
    if (op.kind !== 'append') return
    expect(op.type).toBe('tab')
    expect(op.props).toEqual({
      title: [{ type: 'text', text: { content: 'Tab 1' } }],
      color: 'default',
    })
  })

  it('projects SyncedBlock passthrough content verbatim', () => {
    const { buffer, root } = makeRoot()
    root.render(<SyncedBlock content={{ synced_from: { type: 'block_id', block_id: 'abc123' } }} />)
    const op = buffer.ops[0]!
    if (op.kind !== 'append') return
    expect(op.type).toBe('synced_block')
    expect(op.props).toEqual({ synced_from: { type: 'block_id', block_id: 'abc123' } })
  })

  it('projects media external URL + caption (rich_text)', () => {
    const { buffer, root } = makeRoot()
    root.render(<Image url="https://example.com/x.png" caption={<Bold>alt copy</Bold>} />)
    const op = buffer.ops[0]!
    if (op.kind !== 'append') return
    expect(op.type).toBe('image')
    expect(op.props.type).toBe('external')
    expect(op.props.external).toEqual({ url: 'https://example.com/x.png' })
    const cap = op.props.caption as Array<{
      text: { content: string }
      annotations: { bold: boolean }
    }>
    expect(cap).toHaveLength(1)
    expect(cap[0]!.text.content).toBe('alt copy')
    expect(cap[0]!.annotations.bold).toBe(true)
  })

  it('projects media file_upload envelope when fileUploadId is given', () => {
    const { buffer, root } = makeRoot()
    root.render(<Video fileUploadId="upload_123" caption="demo" />)
    const op = buffer.ops[0]!
    if (op.kind !== 'append') return
    expect(op.type).toBe('video')
    expect(op.props.type).toBe('file_upload')
    expect(op.props.file_upload).toEqual({ id: 'upload_123' })
    expect(op.props).not.toHaveProperty('external')
  })

  it('prefers fileUploadId over url when both are provided', () => {
    const { buffer, root } = makeRoot()
    root.render(<Pdf url="https://example.com/a.pdf" fileUploadId="up_1" />)
    const op = buffer.ops[0]!
    if (op.kind !== 'append') return
    expect(op.props.type).toBe('file_upload')
    expect(op.props.file_upload).toEqual({ id: 'up_1' })
    expect(op.props).not.toHaveProperty('external')
  })

  it('projects table flags + nested table_row cells (Notion API shape)', () => {
    const { buffer, root } = makeRoot()
    root.render(
      <Table tableWidth={3} hasColumnHeader hasRowHeader={false}>
        <TableRow cells={['Tier', 'Price', <Bold key="h">Highlight</Bold>]} />
        <TableRow cells={['A', '$1', 'notes']} />
      </Table>,
    )
    const kinds = buffer.ops.map((o) => ('type' in o ? o.type : o.kind))
    expect(kinds).toEqual(['table', 'table_row', 'table_row'])
    const table = buffer.ops[0]!
    if (table.kind !== 'append') return
    expect(table.props).toEqual({
      table_width: 3,
      has_column_header: true,
      has_row_header: false,
    })
    const row0 = buffer.ops[1]!
    if (row0.kind !== 'append') return
    const cells = row0.props.cells as Array<
      Array<{ text: { content: string }; annotations: { bold: boolean } }>
    >
    expect(cells).toHaveLength(3)
    expect(cells[0]![0]!.text.content).toBe('Tier')
    expect(cells[0]![0]!.annotations.bold).toBe(false)
    expect(cells[2]![0]!.text.content).toBe('Highlight')
    expect(cells[2]![0]!.annotations.bold).toBe(true)
  })

  it('projects Column widthRatio as Notion width_ratio', () => {
    const { buffer, root } = makeRoot()
    root.render(
      <ColumnList>
        <Column widthRatio={2}>
          <Paragraph>left</Paragraph>
        </Column>
        <Column widthRatio={1}>
          <Paragraph>right</Paragraph>
        </Column>
      </ColumnList>,
    )
    const cols = buffer.ops.filter((o) => 'type' in o && o.type === 'column')
    expect(cols).toHaveLength(2)
    const [c0, c1] = cols
    if (c0?.kind !== 'append' || c1?.kind !== 'append') return
    expect(c0.props.width_ratio).toBe(2)
    expect(c1.props.width_ratio).toBe(1)
  })

  it('projects LinkToPage pageId as Notion page_id', () => {
    const { buffer, root } = makeRoot()
    root.render(<LinkToPage pageId="abc-123" />)
    const op = buffer.ops[0]!
    if (op.kind !== 'append') return
    expect(op.type).toBe('link_to_page')
    expect(op.props).toEqual({ page_id: 'abc-123' })
  })

  it('projects ChildPage title verbatim', () => {
    const { buffer, root } = makeRoot()
    root.render(<ChildPage title="Notes" />)
    const op = buffer.ops[0]!
    if (op.kind !== 'append') return
    expect(op.type).toBe('child_page')
    expect(op.props).toEqual({ title: 'Notes' })
  })

  it('projects Breadcrumb as an empty payload', () => {
    const { buffer, root } = makeRoot()
    root.render(<Breadcrumb />)
    const op = buffer.ops[0]!
    if (op.kind !== 'append') return
    expect(op.type).toBe('breadcrumb')
    expect(op.props).toEqual({})
  })

  it('projects ChildDatabase passthrough content verbatim', () => {
    const { buffer, root } = makeRoot()
    root.render(<ChildDatabase content={{ title: 'Tasks' }} />)
    const op = buffer.ops[0]!
    if (op.kind !== 'append') return
    expect(op.type).toBe('child_database')
    expect(op.props).toEqual({ title: 'Tasks' })
  })

  it('keeps inline annotations in rich_text while nesting blocks', () => {
    const { buffer, root } = makeRoot()
    root.render(
      <BulletedListItem>
        hi <Bold>there</Bold>
        <Paragraph>child</Paragraph>
      </BulletedListItem>,
    )
    expect(buffer.ops.map((o) => ('type' in o ? o.type : o.kind))).toEqual([
      'bulleted_list_item',
      'paragraph',
    ])
    const parent = buffer.ops[0]!
    if (parent.kind !== 'append') return
    const rt = parent.props.rich_text as Array<{
      text: { content: string }
      annotations: { bold: boolean }
    }>
    expect(rt.map((r) => [r.text.content, r.annotations.bold])).toEqual([
      ['hi ', false],
      ['there', true],
    ])
  })
})
