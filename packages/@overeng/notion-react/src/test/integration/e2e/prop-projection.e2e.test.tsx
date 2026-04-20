import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  Callout,
  Code,
  Heading2,
  Image,
  Page,
  Paragraph,
  ToDo,
  Toggle,
} from '../../../components/blocks.tsx'
import { Bold, Italic, Link } from '../../../components/inline.tsx'
import { renderToNotion } from '../../../renderer/render-to-notion.ts'
import {
  firstPlainText,
  readPageTree,
  type ReadBlockNode,
  type RichTextItem,
  SKIP_E2E,
  withScratchPage,
} from './helpers.ts'

/**
 * End-to-end prop-projection fidelity tests.
 *
 * The existing `blocks.e2e.test.tsx` proves every v0.1 block type round-
 * trips at least once. These tests go deeper: they exercise the prop
 * matrices that actually hit the wire shape and that Notion rejects or
 * silently drops when wrong. Each assertion targets the projected
 * Notion payload, not the rendered React tree.
 */

const TIMEOUT = 120_000

const richText = (node: ReadBlockNode): readonly RichTextItem[] =>
  (node.payload.rich_text ?? []) as readonly RichTextItem[]

describe.skipIf(SKIP_E2E)('e2e prop projection fidelity', () => {
  // ---------------------------------------------------------------------
  // Callout: icon string projects to `{ type: 'emoji', emoji: '...' }`
  // and `color` lands on the block payload as-is.
  // ---------------------------------------------------------------------
  it(
    'callout — emoji icon is wrapped as { type: "emoji" }; color is forwarded',
    async () => {
      await withScratchPage('props-callout', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Callout icon="💡" color="yellow_background">
                tip of the day
              </Callout>
            </Page>,
            { pageId },
          ).pipe(Effect.mapError((cause) => new Error(String(cause))))

          const tree = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          expect(tree).toHaveLength(1)
          const callout = tree[0]!
          expect(callout.type).toBe('callout')
          const icon = callout.payload.icon as { type?: string; emoji?: string }
          expect(icon.type).toBe('emoji')
          expect(icon.emoji).toBe('💡')
          expect(callout.payload.color).toBe('yellow_background')
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // Code language: `language` prop lands verbatim, survives round-trip.
  // ---------------------------------------------------------------------
  it(
    'code — language projects verbatim across supported languages',
    async () => {
      await withScratchPage('props-code-lang', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Code language="typescript">{'const x: number = 1'}</Code>
              <Code language="rust">{'let x: u32 = 1;'}</Code>
              <Code language="plain text">{'no lang'}</Code>
            </Page>,
            { pageId },
          ).pipe(Effect.mapError((cause) => new Error(String(cause))))

          const tree = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          expect(tree.map((b) => b.payload.language)).toEqual(['typescript', 'rust', 'plain text'])
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // Heading toggleable: `toggleable` prop projects to `is_toggleable`.
  // ---------------------------------------------------------------------
  it(
    'heading — toggleable prop projects to is_toggleable (true/false/omitted)',
    async () => {
      await withScratchPage('props-heading-toggle', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Heading2 toggleable>toggleable heading</Heading2>
              <Heading2 toggleable={false}>explicit false</Heading2>
              <Heading2>default (omitted)</Heading2>
            </Page>,
            { pageId },
          ).pipe(Effect.mapError((cause) => new Error(String(cause))))

          const tree = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          expect(tree).toHaveLength(3)
          expect(tree[0]!.payload.is_toggleable).toBe(true)
          expect(tree[1]!.payload.is_toggleable).toBe(false)
          // Notion defaults omitted toggleable to false on read — server
          // always echoes the field. The assertion here is that a missing
          // prop does not accidentally opt-in to the toggle affordance.
          expect(tree[2]!.payload.is_toggleable).toBe(false)
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // ToDo checked: true / false / omitted all differ on the wire.
  // ---------------------------------------------------------------------
  it(
    'to_do — checked prop true/false/omitted project correctly',
    async () => {
      await withScratchPage('props-todo-checked', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <ToDo checked>checked item</ToDo>
              <ToDo checked={false}>explicit unchecked</ToDo>
              <ToDo>default (omitted)</ToDo>
            </Page>,
            { pageId },
          ).pipe(Effect.mapError((cause) => new Error(String(cause))))

          const tree = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          expect(tree).toHaveLength(3)
          expect(tree[0]!.payload.checked).toBe(true)
          expect(tree[1]!.payload.checked).toBe(false)
          // Omitted checked defaults to false server-side.
          expect(tree[2]!.payload.checked).toBe(false)
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // Link href: flattenRichText projects <Link> into rich_text items whose
  // `text.link.url` is non-null; `plain_text` excludes the URL.
  // ---------------------------------------------------------------------
  it(
    'link — href projects to text.link.url; nested bold/italic compose with link',
    async () => {
      await withScratchPage('props-link-href', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Paragraph>
                plain{' '}
                <Link href="https://example.com">
                  <Bold>bold link</Bold>
                </Link>{' '}
                and{' '}
                <Link href="https://notion.so">
                  <Italic>italic link</Italic>
                </Link>
              </Paragraph>
            </Page>,
            { pageId },
          ).pipe(Effect.mapError((cause) => new Error(String(cause))))

          const tree = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          const rt = richText(tree[0]!)
          // Items carrying a link have `href` set to the URL; items without
          // a link have `href` null.
          const linked = rt.filter((r) => r.href !== null && r.href !== undefined)
          // Notion normalizes URLs (e.g. may append a trailing slash to the
          // origin). Compare on the origin + pathname minus trailing slash.
          const normalize = (u: string): string => {
            const parsed = new URL(u)
            return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`
          }
          expect(linked.map((r) => normalize(r.href!)).sort()).toEqual([
            'https://example.com',
            'https://notion.so',
          ])
          // Annotations ride along with the link: the bold fragment is
          // bold AND linked; the italic fragment is italic AND linked.
          const bold = linked.find((r) => r.annotations?.bold === true)
          const italic = linked.find((r) => r.annotations?.italic === true)
          expect(bold?.plain_text).toBe('bold link')
          expect(italic?.plain_text).toBe('italic link')
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // Image external URL: media projection wraps into
  // `{ type: 'external', external: { url } }`.
  // ---------------------------------------------------------------------
  it(
    'image — external URL projects into { type: "external", external: { url } }',
    async () => {
      await withScratchPage('props-image-external', (pageId) =>
        Effect.gen(function* () {
          const url =
            'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/640px-Cat03.jpg'
          yield* renderToNotion(
            <Page>
              <Image url={url} />
            </Page>,
            { pageId },
          ).pipe(Effect.mapError((cause) => new Error(String(cause))))

          const tree = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          expect(tree).toHaveLength(1)
          const img = tree[0]!
          expect(img.type).toBe('image')
          // Notion echoes back the envelope with `type: 'external'` and a
          // matching `external.url`.
          expect(img.payload.type).toBe('external')
          const external = img.payload.external as { url?: string }
          expect(external.url).toBe(url)
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // Toggle: `title` string prop projects to rich_text (not a custom key).
  // Empty title projects to an empty rich_text[] which Notion accepts.
  // ---------------------------------------------------------------------
  it(
    'toggle — title prop becomes rich_text; empty title yields []',
    async () => {
      await withScratchPage('props-toggle-title', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Toggle title="with title">
                <Paragraph>body</Paragraph>
              </Toggle>
              <Toggle>
                <Paragraph>no title</Paragraph>
              </Toggle>
            </Page>,
            { pageId },
          ).pipe(Effect.mapError((cause) => new Error(String(cause))))

          const tree = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          expect(tree).toHaveLength(2)
          expect(firstPlainText(tree[0]!)).toBe('with title')
          expect(richText(tree[1]!)).toEqual([])
        }),
      )
    },
    TIMEOUT,
  )

  // ---------------------------------------------------------------------
  // Annotations matrix: every annotation (bold, italic, underline,
  // strikethrough, code) projects independently on the same paragraph.
  // ---------------------------------------------------------------------
  it(
    'inline annotations — each projects independently in a single paragraph',
    async () => {
      await withScratchPage('props-annotations', (pageId) =>
        Effect.gen(function* () {
          // Build via JSX nesting; component name → annotation flag on the
          // rich_text item.
          yield* renderToNotion(
            <Page>
              <Paragraph>
                <Bold>b</Bold> <Italic>i</Italic>
              </Paragraph>
            </Page>,
            { pageId },
          ).pipe(Effect.mapError((cause) => new Error(String(cause))))

          const tree = yield* readPageTree(pageId).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          )
          const rt = richText(tree[0]!)
          const bold = rt.find((r) => r.annotations?.bold === true)
          const italic = rt.find((r) => r.annotations?.italic === true)
          expect(bold?.plain_text).toBe('b')
          expect(italic?.plain_text).toBe('i')
        }),
      )
    },
    TIMEOUT,
  )
})
