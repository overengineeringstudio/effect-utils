import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import {
  Bookmark,
  BulletedListItem,
  Callout,
  ChildPage,
  Code,
  Column,
  ColumnList,
  Divider,
  Embed,
  Equation,
  Heading2,
  Image,
  LinkToPage,
  NumberedListItem,
  Paragraph,
  Quote,
  Raw,
  Table,
  TableOfContents,
  TableRow,
  ToDo,
  Toggle,
} from '../components/blocks.ts'
import { Bold, InlineEquation, Link, Mention } from '../components/inline.ts'
import { createFakeNotion, type FakeBlock, type FakeNotion } from '../test/mock-client.ts'
import { observeBlockTree } from './readback-observe.ts'
import {
  compareReadback,
  compareReadbackPage,
  normalizeCandidate,
  type ObservedBlockTree,
} from './readback.ts'
import { buildCandidateTree } from './sync-diff.ts'
import { sync } from './sync.ts'

const ROOT = '00000000-0000-4000-8000-000000000001'
const LINKED = '00000000-0000-4000-8000-00000000abcd'

const runWith = <A, E>(
  fake: FakeNotion,
  eff: Effect.Effect<A, E, HttpClient.HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

/** Read the fake server's live tree back as public-API-shaped block JSON. */
const observeFake = (fake: FakeNotion, parentId: string): readonly ObservedBlockTree[] =>
  fake.childrenOf(parentId).map(
    (b: FakeBlock): ObservedBlockTree => ({
      block: { object: 'block', id: b.id, type: b.type, [b.type]: b.payload },
      children: observeFake(fake, b.id),
    }),
  )

const element: ReactNode = (
  <>
    <Paragraph>
      Hello <Bold>world</Bold> and <Link href="https://overeng.dev">a link</Link>
    </Paragraph>
    <Heading2>Section</Heading2>
    <BulletedListItem>
      item one
      <Paragraph>nested detail</Paragraph>
    </BulletedListItem>
    <Callout icon="⚠️" color="red_background">
      warning text
    </Callout>
    <Callout>plain callout without icon claim</Callout>
  </>
)

/**
 * One block per supported type (beyond the original spike four), rendered
 * through the real reconciler and synced against the Notion-shaped fake.
 *
 * The `<ChildPage>` deliberately comes first: sync's root-scope interleaved
 * apply flushes buffered block ops at each `createPage` boundary, but the
 * diff defers an atomic container's descendant appends until after the
 * sibling run — a `<Table>`/`<ColumnList>` BEFORE a root `<ChildPage>` gets
 * flushed without its inlined children and trips Notion's atomic-create
 * validation. Pre-existing sync behavior, unrelated to readback.
 */
const fullSurfaceElement: ReactNode = (
  <>
    <ChildPage title="Sub page" blockKey="sub" />
    <Quote>quoted wisdom</Quote>
    <NumberedListItem>first</NumberedListItem>
    <ToDo checked>done item</ToDo>
    <ToDo>open item</ToDo>
    <Toggle title="More">
      <Paragraph>hidden</Paragraph>
    </Toggle>
    <Code language="typescript">const x = 1</Code>
    <Divider />
    <TableOfContents />
    <Equation expression="e = mc^2" />
    <Bookmark url="https://overeng.dev" />
    <Embed url="https://overeng.dev/embed" />
    <Image url="https://overeng.dev/pic.png" caption="a picture" />
    <LinkToPage pageId={LINKED} />
    <Table tableWidth={2} hasColumnHeader>
      <TableRow cells={['a', 'b']} />
      <TableRow cells={[<Bold key="c">c</Bold>, 'd']} />
    </Table>
    <ColumnList>
      <Column>
        <Paragraph>left</Paragraph>
      </Column>
      <Column>
        <Paragraph>right</Paragraph>
      </Column>
    </ColumnList>
    <Paragraph>
      see <Mention mention={{ type: 'page', page: { id: LINKED } }} plainText="the page" /> at{' '}
      <InlineEquation expression="x^2" />
    </Paragraph>
  </>
)

/** Response-shape text run with the derived fields real Notion adds. */
const run = (
  text: string,
  overrides?: { readonly bold?: boolean; readonly link?: string },
): Record<string, unknown> => ({
  type: 'text',
  text: { content: text, link: overrides?.link !== undefined ? { url: overrides.link } : null },
  plain_text: text,
  href: overrides?.link ?? null,
  annotations: {
    bold: overrides?.bold ?? false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: 'default',
  },
})

const leaf = (type: string, body: Record<string, unknown>): ObservedBlockTree => ({
  block: { object: 'block', id: `b-${type}`, type, [type]: body },
  children: [],
})

describe('readback normalization oracle', () => {
  it('mock roundtrip: render → sync → observe → hash equality', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(fake, sync(element, { pageId: ROOT, cache }))
    const candidate = buildCandidateTree(element, ROOT)
    const observed = observeFake(fake, ROOT)
    const cmp = compareReadback({ candidate, observed })
    expect(cmp.equal).toBe(true)
    expect(cmp.observedHash).toBe(cmp.candidateHash)
    // The hash is a pure function of the element: a fresh render agrees.
    expect(
      compareReadback({ candidate: buildCandidateTree(element, ROOT), observed }).candidateHash,
    ).toBe(cmp.candidateHash)
  })

  it('mock roundtrip covers the full supported block surface', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(fake, sync(fullSurfaceElement, { pageId: ROOT, cache }))
    const candidate = buildCandidateTree(fullSurfaceElement, ROOT)
    const cmp = compareReadback({ candidate, observed: observeFake(fake, ROOT) })
    expect(cmp.equal).toBe(true)
  })

  it('observeBlockTree walks the children endpoint into the observed shape', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(fake, sync(fullSurfaceElement, { pageId: ROOT, cache }))
    const observed = await runWith(fake, observeBlockTree({ blockId: ROOT }))
    const candidate = buildCandidateTree(fullSurfaceElement, ROOT)
    expect(compareReadback({ candidate, observed }).equal).toBe(true)
    // The walk recurses into nested block children (toggle body)…
    const toggle = observed.find((n) => n.block.type === 'toggle')
    expect(toggle?.children).toHaveLength(1)
    // …but never across the child_page identity boundary.
    const childPage = observed.find((n) => n.block.type === 'child_page')
    expect(childPage?.children).toHaveLength(0)
  })

  it('normalizes realistic response-shape readback into the candidate hash space', () => {
    const candidate = buildCandidateTree(
      <>
        <Paragraph>
          Hello <Bold>world</Bold>
        </Paragraph>
        <Callout>no icon</Callout>
      </>,
      ROOT,
    )
    const observed: ObservedBlockTree[] = [
      {
        block: {
          object: 'block',
          id: 'b1',
          type: 'paragraph',
          paragraph: {
            color: 'default', // response always carries the default explicitly
            rich_text: [
              run('Hel'), // Notion re-segmented the default-frame text —
              run('lo '), // adjacent identical frames must coalesce
              run('world', { bold: true }),
            ],
          },
        },
        children: [],
      },
      {
        block: {
          object: 'block',
          id: 'b2',
          type: 'callout',
          callout: {
            color: 'default',
            // Provider-injected default icon for an authored-null icon: the
            // JSX never claimed one, so this field is provider-owned.
            icon: { type: 'external', external: { url: 'https://www.notion.so/icons/star.svg' } },
            rich_text: [run('no icon')],
          },
        },
        children: [],
      },
    ]
    const cmp = compareReadback({ candidate, observed })
    expect(cmp.equal).toBe(true)
  })

  it('folds provider-injected defaults across the extended surface', () => {
    const candidate = buildCandidateTree(
      <>
        <Code>plain snippet</Code>
        <ToDo>open</ToDo>
        <Table>
          <TableRow cells={['x']} />
        </Table>
        <ColumnList>
          <Column>
            <Paragraph>left</Paragraph>
          </Column>
          <Column>
            <Paragraph>right</Paragraph>
          </Column>
        </ColumnList>
      </>,
      ROOT,
    )
    const observed: ObservedBlockTree[] = [
      // Unclaimed language: Notion injects its default — provider-owned.
      leaf('code', { rich_text: [run('plain snippet')], caption: [], language: 'plain text' }),
      // Explicit default `checked` / `color` on the response side.
      leaf('to_do', { rich_text: [run('open')], checked: false, color: 'default' }),
      {
        // Unclaimed table_width: the server derives it from the rows.
        block: {
          id: 'b-table',
          type: 'table',
          table: { table_width: 1, has_column_header: false, has_row_header: false },
        },
        children: [leaf('table_row', { cells: [[run('x')]] })],
      },
      {
        block: { id: 'b-cl', type: 'column_list', column_list: {} },
        children: [
          {
            // Unclaimed width_ratio: Notion computes and returns one.
            block: { id: 'b-c1', type: 'column', column: { width_ratio: 0.5 } },
            children: [leaf('paragraph', { rich_text: [run('left')], color: 'default' })],
          },
          {
            block: { id: 'b-c2', type: 'column', column: { width_ratio: 0.5 } },
            children: [leaf('paragraph', { rich_text: [run('right')], color: 'default' })],
          },
        ],
      },
    ]
    expect(compareReadback({ candidate, observed }).equal).toBe(true)
  })

  it('masks uploaded media sources but keeps captions exact', () => {
    const candidate = buildCandidateTree(
      <Image fileUploadId="upload-123" caption="diagram" />,
      ROOT,
    )
    // Response for an uploaded asset: `file` envelope with an expiring signed
    // URL — not comparable content, masked to the `uploaded` sentinel.
    const observed = [
      leaf('image', {
        type: 'file',
        file: { url: 'https://s3.amazonaws.com/signed?X-Amz-Expires=3600', expiry_time: 'soon' },
        caption: [run('diagram')],
      }),
    ]
    expect(compareReadback({ candidate, observed }).equal).toBe(true)
    const tampered = [
      leaf('image', {
        type: 'file',
        file: { url: 'https://s3.amazonaws.com/other-signed' },
        caption: [run('not the diagram')],
      }),
    ]
    expect(compareReadback({ candidate, observed: tampered }).equal).toBe(false)
  })

  it('normalizes mention and equation leaves from the expanded response shape', () => {
    const candidate = buildCandidateTree(
      <Paragraph>
        ping <Mention mention={{ type: 'user', user: { object: 'user', id: LINKED } }} /> re{' '}
        <InlineEquation expression="x^2" />
      </Paragraph>,
      ROOT,
    )
    const observed = [
      leaf('paragraph', {
        color: 'default',
        rich_text: [
          run('ping '),
          {
            type: 'mention',
            // The response expands the referenced user object …
            mention: {
              type: 'user',
              user: { object: 'user', id: LINKED, name: 'Someone', avatar_url: null },
            },
            plain_text: '@Someone',
            href: null,
            annotations: run('x').annotations,
          },
          run(' re '),
          {
            type: 'equation',
            equation: { expression: 'x^2' },
            plain_text: 'x^2',
            href: null,
            annotations: run('x').annotations,
          },
        ],
      }),
    ]
    expect(compareReadback({ candidate, observed }).equal).toBe(true)
    const changed = structuredClone(observed) as typeof observed
    ;(
      (changed[0]!.block.paragraph as Record<string, unknown>).rich_text as {
        equation?: { expression: string }
      }[]
    )[3]!.equation = { expression: 'x^3' }
    expect(compareReadback({ candidate, observed: changed }).equal).toBe(false)
  })

  it('detects real content drift: text change and explicit-icon change both break equality', () => {
    const candidate = buildCandidateTree(<Callout icon="⚠️">exact warning</Callout>, ROOT)
    const observedOk: ObservedBlockTree[] = [
      {
        block: {
          id: 'b1',
          type: 'callout',
          callout: {
            color: 'default',
            icon: { type: 'emoji', emoji: '⚠️' },
            rich_text: [run('exact warning')],
          },
        },
        children: [],
      },
    ]
    expect(compareReadback({ candidate, observed: observedOk }).equal).toBe(true)

    const changedText = structuredClone(observedOk) as typeof observedOk
    ;((changedText[0]!.block.callout as Record<string, unknown>).rich_text as unknown[])[0] =
      run('tampered warning')
    expect(compareReadback({ candidate, observed: changedText }).equal).toBe(false)

    const changedIcon = structuredClone(observedOk) as typeof observedOk
    ;(changedIcon[0]!.block.callout as Record<string, unknown>).icon = {
      type: 'emoji',
      emoji: '🎯',
    }
    // Explicit JSX icons are exact managed content — no provider tolerance.
    expect(compareReadback({ candidate, observed: changedIcon }).equal).toBe(false)
  })

  it('detects drift in claimed provider-maskable fields and structured props', () => {
    const candidate = buildCandidateTree(
      <>
        <Code language="typescript">const x = 1</Code>
        <ToDo checked>done</ToDo>
        <Table tableWidth={2}>
          <TableRow cells={['a', 'b']} />
        </Table>
      </>,
      ROOT,
    )
    const observed = (overrides: {
      readonly language?: string
      readonly checked?: boolean
      readonly cellB?: string
    }): ObservedBlockTree[] => [
      leaf('code', {
        rich_text: [run('const x = 1')],
        caption: [],
        language: overrides.language ?? 'typescript',
      }),
      leaf('to_do', {
        rich_text: [run('done')],
        checked: overrides.checked ?? true,
        color: 'default',
      }),
      {
        block: {
          id: 'b-table',
          type: 'table',
          table: { table_width: 2, has_column_header: false, has_row_header: false },
        },
        children: [leaf('table_row', { cells: [[run('a')], [run(overrides.cellB ?? 'b')]] })],
      },
    ]
    expect(compareReadback({ candidate, observed: observed({}) }).equal).toBe(true)
    expect(compareReadback({ candidate, observed: observed({ language: 'rust' }) }).equal).toBe(
      false,
    )
    expect(compareReadback({ candidate, observed: observed({ checked: false }) }).equal).toBe(false)
    expect(compareReadback({ candidate, observed: observed({ cellB: 'tampered' }) }).equal).toBe(
      false,
    )
  })

  it('compares child_page blocks by title identity without crossing the page boundary', () => {
    const candidate = buildCandidateTree(<ChildPage title="Sub page" blockKey="sub" />, ROOT)
    const withChildren: ObservedBlockTree[] = [
      {
        block: { id: 'p1', type: 'child_page', child_page: { title: 'Sub page' } },
        // Live sub-page content is out of scope — its own readback pass owns it.
        children: [leaf('paragraph', { rich_text: [run('sub content')], color: 'default' })],
      },
    ]
    expect(compareReadback({ candidate, observed: withChildren }).equal).toBe(true)
    const renamed: ObservedBlockTree[] = [
      { block: { id: 'p1', type: 'child_page', child_page: { title: 'Renamed' } }, children: [] },
    ]
    expect(compareReadback({ candidate, observed: renamed }).equal).toBe(false)
  })

  it('throws on raw escape-hatch blocks instead of guessing their response shape', () => {
    const candidate = buildCandidateTree(
      <Raw type="synced_block" content={{ synced_from: null }} />,
      ROOT,
    )
    expect(() => normalizeCandidate(candidate.children)).toThrow(
      /readback normalization not implemented for synced_block/,
    )
  })
})

describe('readback page-metadata comparison', () => {
  const pageJson = (overrides?: {
    readonly title?: readonly Record<string, unknown>[]
    readonly icon?: Record<string, unknown> | null
    readonly cover?: Record<string, unknown> | null
  }): Record<string, unknown> => ({
    object: 'page',
    id: ROOT,
    icon: overrides?.icon ?? null,
    cover: overrides?.cover ?? null,
    properties: {
      title: { id: 'title', type: 'title', title: overrides?.title ?? [run('My page')] },
    },
  })

  it('claimed title compares through response decoration and re-segmentation', () => {
    const candidate = { title: [{ type: 'text', text: { content: 'My page' } }] }
    expect(
      compareReadbackPage({
        candidate,
        observed: pageJson({ title: [run('My '), run('page')] }),
      }).equal,
    ).toBe(true)
    expect(
      compareReadbackPage({ candidate, observed: pageJson({ title: [run('Renamed')] }) }).equal,
    ).toBe(false)
  })

  it('unclaimed fields are masked; null claims a server-side clear', () => {
    // No claims at all: any observed metadata is fine.
    expect(
      compareReadbackPage({
        candidate: {},
        observed: pageJson({ icon: { type: 'emoji', emoji: '🎯' } }),
      }).equal,
    ).toBe(true)
    // Claimed clear: observed must be unset.
    expect(compareReadbackPage({ candidate: { icon: null }, observed: pageJson() }).equal).toBe(
      true,
    )
    expect(
      compareReadbackPage({
        candidate: { icon: null },
        observed: pageJson({ icon: { type: 'emoji', emoji: '🎯' } }),
      }).equal,
    ).toBe(false)
  })

  it('claimed icons compare exactly; builtin-URL icons mask to unverified (A07)', () => {
    const emoji = { type: 'emoji', emoji: '🚀' }
    expect(
      compareReadbackPage({ candidate: { icon: emoji }, observed: pageJson({ icon: emoji }) })
        .equal,
    ).toBe(true)
    expect(
      compareReadbackPage({
        candidate: { icon: emoji },
        observed: pageJson({ icon: { type: 'emoji', emoji: '🎯' } }),
      }).equal,
    ).toBe(false)
    // Built-in icon URL resolves server-side to the undocumented `icon`
    // envelope; the name↔URL mapping is not public, so presence is verified
    // but the exact glyph is masked.
    expect(
      compareReadbackPage({
        candidate: {
          icon: { type: 'external', external: { url: 'https://www.notion.so/icons/star.svg' } },
        },
        observed: pageJson({ icon: { type: 'icon', icon: { name: 'star', color: 'gray' } } }),
      }).equal,
    ).toBe(true)
  })

  it('covers compare by URL for external and mask for uploaded assets', () => {
    const external = { type: 'external', external: { url: 'https://overeng.dev/cover.png' } }
    expect(
      compareReadbackPage({
        candidate: { cover: external },
        observed: pageJson({ cover: external }),
      }).equal,
    ).toBe(true)
    expect(
      compareReadbackPage({
        candidate: { cover: external },
        observed: pageJson({
          cover: { type: 'external', external: { url: 'https://overeng.dev/other.png' } },
        }),
      }).equal,
    ).toBe(false)
    expect(
      compareReadbackPage({
        candidate: { cover: { type: 'file_upload', file_upload: { id: 'up-1' } } },
        observed: pageJson({
          cover: {
            type: 'file',
            file: { url: 'https://s3.amazonaws.com/signed', expiry_time: 't' },
          },
        }),
      }).equal,
    ).toBe(true)
  })
})
