import { describe, expect, it } from 'vitest'

import { createNotionRoot } from '../renderer/host-config.ts'
import { OpBuffer } from '../renderer/op-buffer.ts'
import { buildCandidateTree } from '../renderer/sync-diff.ts'
import {
  Bookmark,
  BulletedListItem,
  Callout,
  ChildPage,
  Code,
  Divider,
  Equation,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Image,
  Page,
  Paragraph,
  TableOfContents,
  ToDo,
  Toggle,
} from './blocks.ts'

const collect = (element: React.ReactNode) => {
  const buffer = new OpBuffer('root')
  const root = createNotionRoot(buffer, 'root')
  root.render(<>{element}</>)
  return buffer.ops
}

/**
 * Render and expose the container so tests can inspect the `page_root`
 * wrapper and top-level instances — the regular `collect` helper only
 * surfaces the emitted op stream.
 */
const renderWithContainer = (element: React.ReactNode) => {
  const buffer = new OpBuffer('root')
  const root = createNotionRoot(buffer, 'root')
  root.render(<>{element}</>)
  return { ops: buffer.ops, container: root.container }
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

  // Ergonomic wrappers that also need blockKey for real-world collections:
  // daily-page renderers commonly produce lists of <Paragraph> / <ToDo> /
  // <BulletedListItem> where a mid-list insert must not degrade to a tail
  // remove+re-insert. Regression guard for the docs promise in
  // `docs/getting-started.md#rendering-a-list`.
  it.each([
    ['Paragraph', () => <Paragraph blockKey="p-1">x</Paragraph>, 'paragraph'],
    [
      'BulletedListItem',
      () => <BulletedListItem blockKey="b-1">x</BulletedListItem>,
      'bulleted_list_item',
    ],
    ['ToDo', () => <ToDo blockKey="t-1">x</ToDo>, 'to_do'],
    ['Code', () => <Code blockKey="c-1">x</Code>, 'code'],
  ])('%s threads blockKey into the reconciler identity', (_name, factory, expectedType) => {
    const tree = buildCandidateTree(factory(), 'root')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]!.key).toMatch(/^k:/)
    expect(tree.children[0]!.type).toBe(expectedType)
    expect((tree.children[0]!.props as { blockKey?: unknown }).blockKey).toBeUndefined()
  })
})

/**
 * Phase 3a of #618: `<Page>` is now a virtual `page_root` host wrapper that
 * carries optional page-level metadata (title/icon/cover). The reconciler
 * folds its children into the container's top-level so existing usage
 * (wrapping a block tree in `<Page>`) keeps emitting the same block ops,
 * while the metadata lands on `container.pageRoot` for phase 3b wiring.
 */
describe('Page component (page_root wrapper)', () => {
  it('carries title/icon/cover on the container.pageRoot (never emitted as a block op)', () => {
    const { ops, container } = renderWithContainer(
      <Page
        title="Root Page"
        icon={{ type: 'emoji', emoji: '📘' }}
        cover={{ type: 'external', external: { url: 'https://x/cover.png' } }}
      >
        <Paragraph>hi</Paragraph>
      </Page>,
    )
    // `page_root` itself must NOT produce a block op; only the child does.
    expect(ops.map((o) => ('type' in o ? o.type : o.kind))).toEqual(['paragraph'])
    expect(container.pageRoot).not.toBeNull()
    expect(container.pageRoot!.type).toBe('page_root')
    expect(container.pageRoot!.nodeKind).toBe('page')
    // Props bag carries the page-level metadata (plus React's own `children`
    // passthrough, which we ignore here — only title/icon/cover are relevant
    // for the phase 3b page-update emission).
    expect(container.pageRoot!.props.title).toBe('Root Page')
    expect(container.pageRoot!.props.icon).toEqual({ type: 'emoji', emoji: '📘' })
    expect(container.pageRoot!.props.cover).toEqual({
      type: 'external',
      external: { url: 'https://x/cover.png' },
    })
  })

  it('folds children into top-level so existing unwrapped usage keeps working', () => {
    const wrapped = renderWithContainer(
      <Page>
        <Paragraph>a</Paragraph>
        <Paragraph>b</Paragraph>
      </Page>,
    )
    const bare = renderWithContainer(
      <>
        <Paragraph>a</Paragraph>
        <Paragraph>b</Paragraph>
      </>,
    )
    // Two blocks either way — the wrapper is transparent to the op stream.
    expect(wrapped.ops.map((o) => ('type' in o ? o.type : o.kind))).toEqual([
      'paragraph',
      'paragraph',
    ])
    expect(bare.ops.map((o) => ('type' in o ? o.type : o.kind))).toEqual(['paragraph', 'paragraph'])
    expect(wrapped.container.topLevel.map((i) => i.type)).toEqual(['paragraph', 'paragraph'])
  })

  it('Page with no metadata still registers the wrapper on the container', () => {
    const { container } = renderWithContainer(
      <Page>
        <Paragraph>x</Paragraph>
      </Page>,
    )
    expect(container.pageRoot).not.toBeNull()
    expect(container.pageRoot!.props.title).toBeUndefined()
    expect(container.pageRoot!.props.icon).toBeUndefined()
    expect(container.pageRoot!.props.cover).toBeUndefined()
  })
})

describe('ChildPage component (page-boundary block)', () => {
  it('projects icon and cover into the append op props', () => {
    const ops = collect(
      <ChildPage
        title="Notes"
        icon={{ type: 'emoji', emoji: '📝' }}
        cover={{ type: 'external', external: { url: 'https://x/c.png' } }}
      />,
    )
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.type).toBe('child_page')
    expect(op.props).toEqual({
      title: 'Notes',
      icon: { type: 'emoji', emoji: '📝' },
      cover: { type: 'external', external: { url: 'https://x/c.png' } },
    })
  })

  it('accepts a rich PageTitleSpan[] and projects it verbatim', () => {
    const ops = collect(
      <ChildPage
        title={[
          { type: 'text', text: { content: 'Hello ' }, annotations: { bold: true } },
          { type: 'text', text: { content: 'world' } },
        ]}
      />,
    )
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.type).toBe('child_page')
    expect((op.props as { title: readonly unknown[] }).title).toHaveLength(2)
  })

  it('ChildPage with custom_emoji icon projects the full envelope', () => {
    const ops = collect(
      <ChildPage
        title="x"
        icon={{
          type: 'custom_emoji',
          custom_emoji: { id: '00000000-0000-4000-8000-000000000abc' },
        }}
      />,
    )
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect((op.props as { icon: unknown }).icon).toEqual({
      type: 'custom_emoji',
      custom_emoji: { id: '00000000-0000-4000-8000-000000000abc' },
    })
  })

  it('ChildPage with no props emits a child_page append with empty props', () => {
    const ops = collect(<ChildPage />)
    const op = ops[0]!
    if (op.kind !== 'append') throw new Error('expected append')
    expect(op.type).toBe('child_page')
    expect(op.props).toEqual({})
  })

  it('ChildPage reconciler instance is marked nodeKind: page', () => {
    const { container } = renderWithContainer(<ChildPage title="x" />)
    expect(container.topLevel[0]!.type).toBe('child_page')
    expect(container.topLevel[0]!.nodeKind).toBe('page')
  })
})
