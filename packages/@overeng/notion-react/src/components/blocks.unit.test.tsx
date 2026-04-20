import { describe, expect, it } from 'vitest'

import { createNotionRoot } from '../renderer/host-config.ts'
import { OpBuffer } from '../renderer/op-buffer.ts'
import { buildCandidateTree } from '../renderer/sync-diff.ts'
import {
  Bookmark,
  BulletedListItem,
  Callout,
  Code,
  Divider,
  Equation,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Image,
  Paragraph,
  TableOfContents,
  ToDo,
  Toggle,
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
    expect(op.props.type).toBe('external')
    expect(op.props.external).toEqual({ url: 'https://x/p.png' })
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

/**
 * Prop-variation matrix. The Callout component takes `color` as a single
 * string field: Notion encodes both foreground colors and background variants
 * into one enum (e.g. `"red"` vs `"red_background"`). The 10 named colors
 * plus 9 background variants (default has no `_background` form in Notion)
 * yield 19 distinct values; we assert each round-trips through `blockProps`.
 */
const NOTION_CALLOUT_COLORS = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
  'gray_background',
  'brown_background',
  'orange_background',
  'yellow_background',
  'green_background',
  'blue_background',
  'purple_background',
  'pink_background',
  'red_background',
] as const

describe('callout color variants', () => {
  it.each(NOTION_CALLOUT_COLORS)('projects color=%s verbatim', (color) => {
    const ops = collect(<Callout color={color}>x</Callout>)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.type).toBe('callout')
    expect(op.props.color).toBe(color)
  })
})

describe('callout icon variants', () => {
  it('projects emoji icon as { type: "emoji", emoji }', () => {
    const ops = collect(<Callout icon="🔔">x</Callout>)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.props.icon).toEqual({ type: 'emoji', emoji: '🔔' })
  })

  it('projects external-url icon as { type: "external", external: { url } }', () => {
    const ops = collect(<Callout icon={{ external: 'https://x/icon.png' }}>x</Callout>)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.props.icon).toEqual({
      type: 'external',
      external: { url: 'https://x/icon.png' },
    })
  })
})

/**
 * Representative code languages across major families. `@overeng/notion-effect-schema`
 * does not currently export a language enum, so we sample 20 rather than
 * iterating the full ~60 Notion supports.
 */
const CODE_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'rust',
  'go',
  'java',
  'c',
  'c++',
  'c#',
  'ruby',
  'php',
  'swift',
  'kotlin',
  'sql',
  'bash',
  'shell',
  'yaml',
  'json',
  'markdown',
  'plain text',
] as const

describe('code block language variants', () => {
  it.each(CODE_LANGUAGES)('projects language=%s verbatim', (language) => {
    const ops = collect(<Code language={language}>x</Code>)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.type).toBe('code')
    expect(op.props.language).toBe(language)
  })
})

describe('heading toggleable variants', () => {
  it('heading_1 toggleable projects is_toggleable: true', () => {
    const ops = collect(<Heading1 toggleable>x</Heading1>)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.type).toBe('heading_1')
    expect(op.props.is_toggleable).toBe(true)
  })

  it('heading_3 toggleable projects is_toggleable: true', () => {
    const ops = collect(<Heading3 toggleable>x</Heading3>)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.type).toBe('heading_3')
    expect(op.props.is_toggleable).toBe(true)
  })

  it('heading_4 toggleable projects is_toggleable: true', () => {
    const ops = collect(<Heading4 toggleable>x</Heading4>)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.type).toBe('heading_4')
    expect(op.props.is_toggleable).toBe(true)
  })
})

/**
 * `blockKey` is the reconciler's identity hint. It must land as `k:<key>` in
 * the candidate-tree keyspace (used by sync-diff's LCS) and must NOT appear
 * in the projected Notion payload. These tests cover the ergonomic components
 * that historically forced authors to drop to `h(...)` to supply a blockKey.
 */
describe('blockKey on ergonomic components', () => {
  it('Toggle threads blockKey into the reconciler identity', () => {
    const tree = buildCandidateTree(
      <Toggle blockKey="foo" title="t">
        <Paragraph>body</Paragraph>
      </Toggle>,
      'root',
    )
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]!.key).toBe('k:foo')
    expect(tree.children[0]!.type).toBe('toggle')
    expect((tree.children[0]!.props as { blockKey?: unknown }).blockKey).toBeUndefined()
  })

  it('Heading2 threads blockKey into the reconciler identity', () => {
    const tree = buildCandidateTree(<Heading2 blockKey="bar">t</Heading2>, 'root')
    expect(tree.children[0]!.key).toBe('k:bar')
    expect(tree.children[0]!.type).toBe('heading_2')
    expect((tree.children[0]!.props as { blockKey?: unknown }).blockKey).toBeUndefined()
  })

  it('Callout threads blockKey into the reconciler identity', () => {
    const tree = buildCandidateTree(
      <Callout blockKey="baz" icon="💡">
        note
      </Callout>,
      'root',
    )
    expect(tree.children[0]!.key).toBe('k:baz')
    expect(tree.children[0]!.type).toBe('callout')
    expect((tree.children[0]!.props as { blockKey?: unknown }).blockKey).toBeUndefined()
  })

  it('omitting blockKey falls back to positional key', () => {
    const tree = buildCandidateTree(<Toggle title="t">body</Toggle>, 'root')
    expect(tree.children[0]!.key).toBe('p:0')
  })
})
