import { describe, expect, it } from 'vitest'

import { BulletedListItem, Heading1, Paragraph, Toggle } from '../components/blocks.tsx'
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

  it('projects bulleted list item rich_text', () => {
    const { buffer, root } = makeRoot()
    root.render(<BulletedListItem>first</BulletedListItem>)
    const op = buffer.ops[0]!
    expect(op.kind).toBe('append')
    if (op.kind !== 'append') return
    expect(op.type).toBe('bulleted_list_item')
    expect(Array.isArray(op.props.rich_text)).toBe(true)
  })
})
