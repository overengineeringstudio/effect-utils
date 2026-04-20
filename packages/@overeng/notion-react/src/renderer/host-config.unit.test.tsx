import { describe, expect, it } from 'vitest'

import {
  BulletedListItem,
  Callout,
  Heading1,
  NumberedListItem,
  Paragraph,
  Quote,
  Raw,
  SyncedBlock,
  ToDo,
  Toggle,
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
