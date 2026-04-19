import { describe, expect, it } from 'vitest'

import { createNotionRoot } from '../renderer/host-config.ts'
import { OpBuffer } from '../renderer/op-buffer.ts'
import {
  Bookmark,
  BulletedListItem,
  Callout,
  Code,
  Divider,
  Equation,
  Heading1,
  Image,
  Paragraph,
  ToDo,
  TableOfContents,
} from './blocks.tsx'

const collect = (element: React.ReactNode) => {
  const buffer = new OpBuffer('root')
  const root = createNotionRoot(buffer, 'root')
  root.render(<>{element}</>)
  return buffer.ops
}

describe('block components', () => {
  it('renders paragraph with rich_text', () => {
    const ops = collect(<Paragraph>hi</Paragraph>)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.type).toBe('paragraph')
    expect(op.props.rich_text).toBeInstanceOf(Array)
  })

  it('renders heading_1 with toggleable flag', () => {
    const ops = collect(<Heading1 toggleable>Title</Heading1>)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.props.is_toggleable).toBe(true)
  })

  it('renders to_do with checked state', () => {
    const ops = collect(<ToDo checked>done</ToDo>)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.props.checked).toBe(true)
  })

  it('renders code with language', () => {
    const ops = collect(<Code language="ts">const x = 1</Code>)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.props.language).toBe('ts')
  })

  it('renders callout with icon and color', () => {
    const ops = collect(
      <Callout icon="💡" color="blue_background">
        note
      </Callout>,
    )
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.props.icon).toEqual({ type: 'emoji', emoji: '💡' })
    expect(op.props.color).toBe('blue_background')
  })

  it('renders divider', () => {
    const ops = collect(<Divider />)
    expect(ops[0]!.kind === 'append' && ops[0]!.type).toBe('divider')
  })

  it('renders image with url', () => {
    const ops = collect(<Image url="https://x/p.png" />)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.type).toBe('image')
    expect(op.props.url).toBe('https://x/p.png')
  })

  it('renders bookmark', () => {
    const ops = collect(<Bookmark url="https://x" />)
    expect(ops[0]!.kind === 'append' && ops[0]!.type).toBe('bookmark')
  })

  it('renders equation', () => {
    const ops = collect(<Equation expression="x^2" />)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.props.expression).toBe('x^2')
  })

  it('renders table_of_contents', () => {
    const ops = collect(<TableOfContents />)
    expect(ops[0]!.kind === 'append' && ops[0]!.type).toBe('table_of_contents')
  })

  it('renders bulleted_list_item with nested children', () => {
    const ops = collect(<BulletedListItem>item</BulletedListItem>)
    expect(ops[0]!.kind === 'append' && ops[0]!.type).toBe('bulleted_list_item')
  })
})
