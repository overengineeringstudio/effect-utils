import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  Bookmark,
  Breadcrumb,
  BulletedListItem,
  Callout,
  Code,
  Column,
  ColumnList,
  Divider,
  Embed,
  Equation,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Image,
  LinkToPage,
  NumberedListItem,
  Page,
  Paragraph,
  Quote,
  Raw,
  Table,
  TableOfContents,
  TableRow,
  ToDo,
  Toggle,
} from '../../../components/blocks.tsx'
import { Bold, InlineEquation, Italic, Link } from '../../../components/inline.tsx'
import { renderToNotion } from '../../../renderer/render-to-notion.ts'
import {
  concatPlainText,
  firstPlainText,
  readPageTree,
  type RichTextItem,
  SKIP_E2E,
  TEST_PARENT_PAGE_ID,
  withScratchPage,
} from './helpers.ts'

/**
 * Per-block-type E2E round-trip coverage for v0.1 blocks.
 *
 * Pattern for every test:
 *   1. Create a fresh scratch subpage under `NOTION_TEST_PARENT_PAGE_ID`.
 *   2. Render a minimal JSX tree that exercises the block under test.
 *   3. Fetch the resulting block tree back via the Notion API.
 *   4. Assert the block type + semantic payload (rich text, flags, colors).
 *   5. Archive the scratch page on teardown (even on failure).
 *
 * Scope of this file — v0.1 block types enumerated in the task spec:
 *   paragraph (plain + rich-text variants), heading_1..heading_4 (plain +
 *   toggleable), bulleted_list_item, numbered_list_item, to_do (checked +
 *   unchecked), toggle, code, quote, callout (color + icon), divider,
 *   image (external url), bookmark, embed, equation (block + inline),
 *   column_list + column, link_to_page, table_of_contents, breadcrumb,
 *   video / file / pdf / audio.
 *
 * The media types `video` / `audio` / `file` / `pdf` require uploaded
 * (internal) file refs on create via the file_upload API; their tests are
 * marked `it.skip` and will be exercised once the upload pipeline lands.
 */

const DEFAULT_TIMEOUT = 60_000

describe.skipIf(SKIP_E2E)('v0.1 block round-trip (e2e)', () => {
  // -----------------------------------------------------------------
  // paragraph
  // -----------------------------------------------------------------

  it(
    'paragraph — plain text',
    async () => {
      await withScratchPage('paragraph-plain', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Paragraph>hello world</Paragraph>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree).toHaveLength(1)
          expect(tree[0]!.type).toBe('paragraph')
          expect(firstPlainText(tree[0]!)).toBe('hello world')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  it(
    'paragraph — bold + italic + link rich text',
    async () => {
      await withScratchPage('paragraph-rich', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Paragraph>
                <Bold>bold</Bold> <Italic>italic</Italic>{' '}
                <Link href="https://example.com">link</Link>
              </Paragraph>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          const rt = tree[0]!.payload.rich_text as readonly RichTextItem[]
          const bold = rt.find((r) => r.annotations?.bold)
          const italic = rt.find((r) => r.annotations?.italic)
          const link = rt.find((r) => r.plain_text === 'link')
          expect(bold?.plain_text).toBe('bold')
          expect(italic?.plain_text).toBe('italic')
          // Notion normalizes bare-host hrefs with a trailing slash.
          expect(link?.href?.replace(/\/$/, '')).toBe('https://example.com')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  it(
    'paragraph — inline equation (<InlineEquation>)',
    async () => {
      await withScratchPage('paragraph-inline-equation', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Paragraph>
                inline: <InlineEquation expression="x^2 + y^2" />
              </Paragraph>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree[0]!.type).toBe('paragraph')
          const rt = tree[0]!.payload.rich_text as readonly {
            type?: string
            equation?: { expression?: string }
          }[]
          const eq = rt.find((r) => r.type === 'equation')
          expect(eq?.equation?.expression).toBe('x^2 + y^2')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // headings (1–4) + toggleable
  // -----------------------------------------------------------------

  it(
    'heading_1 / heading_2 / heading_3 / heading_4 — plain',
    async () => {
      await withScratchPage('headings-all-levels', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Heading1>h1</Heading1>
              <Heading2>h2</Heading2>
              <Heading3>h3</Heading3>
              <Heading4>h4</Heading4>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          // Notion API does not currently expose `heading_4`; rendering an
          // h4 falls back to `heading_3` on the wire. Assert the block
          // stream contains h1/h2/h3 and that the h4 source was accepted
          // without error.
          const types = tree.map((b) => b.type)
          expect(types).toContain('heading_1')
          expect(types).toContain('heading_2')
          expect(types).toContain('heading_3')
          expect(firstPlainText(tree.find((b) => b.type === 'heading_1')!)).toBe('h1')
          expect(firstPlainText(tree.find((b) => b.type === 'heading_2')!)).toBe('h2')
          expect(firstPlainText(tree.find((b) => b.type === 'heading_3')!)).toBe('h3')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  it(
    'heading_2 toggleable with nested paragraph',
    async () => {
      await withScratchPage('heading-toggleable', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Heading2 toggleable>h2 toggle</Heading2>
              <Paragraph>nested body</Paragraph>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          const h2 = tree.find((b) => b.type === 'heading_2')
          expect(h2).toBeDefined()
          expect(h2!.payload.is_toggleable).toBe(true)
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // list items
  // -----------------------------------------------------------------

  it(
    'bulleted_list_item + numbered_list_item',
    async () => {
      await withScratchPage('list-items', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <BulletedListItem>bulleted</BulletedListItem>
              <NumberedListItem>numbered</NumberedListItem>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree.map((b) => b.type)).toEqual(['bulleted_list_item', 'numbered_list_item'])
          expect(firstPlainText(tree[0]!)).toBe('bulleted')
          expect(firstPlainText(tree[1]!)).toBe('numbered')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // to_do
  // -----------------------------------------------------------------

  it(
    'to_do — checked',
    async () => {
      await withScratchPage('todo-checked', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <ToDo checked>done</ToDo>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree[0]!.type).toBe('to_do')
          expect(tree[0]!.payload.checked).toBe(true)
          expect(firstPlainText(tree[0]!)).toBe('done')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  it(
    'to_do — unchecked',
    async () => {
      await withScratchPage('todo-unchecked', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <ToDo checked={false}>pending</ToDo>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree[0]!.type).toBe('to_do')
          expect(tree[0]!.payload.checked).toBe(false)
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // toggle
  // -----------------------------------------------------------------

  it(
    'toggle — with nested paragraph (children fidelity)',
    async () => {
      await withScratchPage('toggle-children', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Toggle title="click me">
                <Paragraph>inside toggle</Paragraph>
              </Toggle>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          const toggle = tree.find((b) => b.type === 'toggle')
          expect(toggle).toBeDefined()
          const child = toggle!.children.find((c) => c.type === 'paragraph')
          expect(child).toBeDefined()
          expect(firstPlainText(child!)).toBe('inside toggle')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  it(
    'toggle — title becomes rich_text[] header',
    async () => {
      await withScratchPage('toggle-title', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Toggle title="click me">
                <Paragraph>body</Paragraph>
              </Toggle>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          const toggle = tree.find((b) => b.type === 'toggle')
          expect(firstPlainText(toggle!)).toBe('click me')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // code
  // -----------------------------------------------------------------

  it(
    'code — language + content',
    async () => {
      await withScratchPage('code', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Code language="typescript">const x = 1</Code>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree[0]!.type).toBe('code')
          expect(tree[0]!.payload.language).toBe('typescript')
          expect(firstPlainText(tree[0]!)).toBe('const x = 1')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // quote
  // -----------------------------------------------------------------

  it(
    'quote',
    async () => {
      await withScratchPage('quote', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Quote>to be, or not to be</Quote>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree[0]!.type).toBe('quote')
          expect(firstPlainText(tree[0]!)).toBe('to be, or not to be')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // callout — color + icon variants
  // -----------------------------------------------------------------

  it(
    'callout — emoji icon + colored background',
    async () => {
      await withScratchPage('callout-icon-color', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Callout icon="💡" color="blue_background">
                heads up
              </Callout>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree[0]!.type).toBe('callout')
          const payload = tree[0]!.payload as {
            icon?: { type?: string; emoji?: string }
            color?: string
          }
          expect(payload.icon?.type).toBe('emoji')
          expect(payload.icon?.emoji).toBe('💡')
          expect(payload.color).toBe('blue_background')
          expect(firstPlainText(tree[0]!)).toBe('heads up')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // divider
  // -----------------------------------------------------------------

  it(
    'divider',
    async () => {
      await withScratchPage('divider', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Divider />
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree[0]!.type).toBe('divider')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // image — external URL
  // -----------------------------------------------------------------

  it(
    'image — external URL',
    async () => {
      await withScratchPage('image-external', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Image url="https://www.notion.so/images/logo-ios.png" />
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree[0]!.type).toBe('image')
          const payload = tree[0]!.payload as { type?: string; external?: { url?: string } }
          expect(payload.type).toBe('external')
          expect(payload.external?.url).toBe('https://www.notion.so/images/logo-ios.png')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // bookmark + embed
  // -----------------------------------------------------------------

  it(
    'bookmark',
    async () => {
      await withScratchPage('bookmark', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Bookmark url="https://example.com" />
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree[0]!.type).toBe('bookmark')
          expect(tree[0]!.payload.url).toBe('https://example.com')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  it(
    'embed',
    async () => {
      await withScratchPage('embed', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Embed url="https://example.com" />
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree[0]!.type).toBe('embed')
          expect(tree[0]!.payload.url).toBe('https://example.com')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // equation — block
  // -----------------------------------------------------------------

  it(
    'equation — block',
    async () => {
      await withScratchPage('equation-block', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Equation expression="E = mc^2" />
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree[0]!.type).toBe('equation')
          expect(tree[0]!.payload.expression).toBe('E = mc^2')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // column_list + column
  // -----------------------------------------------------------------

  it(
    'column_list + column (2 columns, each with a paragraph)',
    async () => {
      await withScratchPage('columns', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <ColumnList>
                <Column>
                  <Paragraph>left</Paragraph>
                </Column>
                <Column>
                  <Paragraph>right</Paragraph>
                </Column>
              </ColumnList>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          const cl = tree.find((b) => b.type === 'column_list')
          expect(cl).toBeDefined()
          const cols = cl!.children.filter((c) => c.type === 'column')
          expect(cols).toHaveLength(2)
          expect(firstPlainText(cols[0]!.children[0]!)).toBe('left')
          expect(firstPlainText(cols[1]!.children[0]!)).toBe('right')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // link_to_page
  // -----------------------------------------------------------------

  it(
    'link_to_page — points to the parent test page',
    async () => {
      await withScratchPage('link-to-page', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <LinkToPage pageId={TEST_PARENT_PAGE_ID} />
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree[0]!.type).toBe('link_to_page')
          const payload = tree[0]!.payload as { page_id?: string; type?: string }
          expect(payload.page_id?.replace(/-/g, '')).toBe(TEST_PARENT_PAGE_ID.replace(/-/g, ''))
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // table_of_contents
  // -----------------------------------------------------------------

  it(
    'table_of_contents',
    async () => {
      await withScratchPage('toc', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Heading1>first</Heading1>
              <TableOfContents />
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree.find((b) => b.type === 'table_of_contents')).toBeDefined()
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // breadcrumb
  // -----------------------------------------------------------------

  // TODO(renderer): `Breadcrumb` currently piped through `Raw`, which the
  // renderer emits with an empty payload body; Notion accepts the empty
  // create but the `Raw` escape hatch is not ergonomic. Not yet a first-
  // class wrapper — tracked for v0.2.
  it(
    'breadcrumb',
    async () => {
      await withScratchPage('breadcrumb', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Breadcrumb />
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree.find((b) => b.type === 'breadcrumb')).toBeDefined()
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // video / file / pdf / audio — external URLs are rejected by Notion for
  // most media types on create (requires upload). Covered in v0.2 once the
  // upload registry is wired. Listed explicitly as `.skip` so the coverage
  // gap is visible in test output.
  // -----------------------------------------------------------------

  // -----------------------------------------------------------------
  // Raw escape hatch — arbitrary block types via <Raw type="..." content={...}>
  // -----------------------------------------------------------------

  it(
    'raw — breadcrumb projection via bare <Raw>',
    async () => {
      await withScratchPage('raw-breadcrumb', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Raw type="breadcrumb" content={{}} />
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree.find((b) => b.type === 'breadcrumb')).toBeDefined()
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  // -----------------------------------------------------------------
  // table + table_row (3 columns × 4 rows, column header)
  // -----------------------------------------------------------------

  it(
    'table — 3×4 with column header + inline annotations in cells',
    async () => {
      await withScratchPage('table-3x4', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Table tableWidth={3} hasColumnHeader>
                <TableRow cells={['Tier', 'Price', 'Notes']} />
                <TableRow cells={['One', '$89', <Bold key="n1">core</Bold>]} />
                <TableRow cells={['Plus', '$129', <Italic key="n2">adds temp</Italic>]} />
                <TableRow cells={['Pro', '$179', 'full RGB']} />
              </Table>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          const table = tree.find((b) => b.type === 'table')
          expect(table).toBeDefined()
          const tablePayload = table!.payload as {
            table_width: number
            has_column_header: boolean
            has_row_header: boolean
          }
          expect(tablePayload.table_width).toBe(3)
          expect(tablePayload.has_column_header).toBe(true)
          expect(tablePayload.has_row_header).toBe(false)
          expect(table!.children).toHaveLength(4)
          const firstRow = table!.children[0]!
          expect(firstRow.type).toBe('table_row')
          const cellText = (cell: readonly RichTextItem[]): string =>
            cell.map((rt) => rt.plain_text ?? '').join('')
          const firstCells = (firstRow.payload as { cells: RichTextItem[][] }).cells
          expect(firstCells).toHaveLength(3)
          expect(cellText(firstCells[0]!)).toBe('Tier')
          expect(cellText(firstCells[1]!)).toBe('Price')
          expect(cellText(firstCells[2]!)).toBe('Notes')
          const secondRow = table!.children[1]!
          const secondCells = (secondRow.payload as { cells: RichTextItem[][] }).cells
          expect(cellText(secondCells[2]!)).toBe('core')
          expect(secondCells[2]![0]!.annotations?.bold).toBe(true)
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )

  it.skip('video — external URL (requires file_upload API, v0.2)', () => {})
  it.skip('audio — external URL (requires file_upload API, v0.2)', () => {})
  it.skip('file — external URL (requires file_upload API, v0.2)', () => {})
  it.skip('pdf — external URL (requires file_upload API, v0.2)', () => {})

  // -----------------------------------------------------------------
  // Deep / mixed content — smoke test covering a multi-block page with
  // rich text inside multiple block types, confirming order is preserved.
  // -----------------------------------------------------------------

  it(
    'mixed-content page preserves block order + rich text',
    async () => {
      await withScratchPage('mixed-content', (pageId) =>
        Effect.gen(function* () {
          yield* renderToNotion(
            <Page>
              <Heading1>Title</Heading1>
              <Paragraph>
                a <Bold>bold</Bold> paragraph
              </Paragraph>
              <BulletedListItem>first bullet</BulletedListItem>
              <Divider />
              <Quote>quoted</Quote>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          expect(tree.map((b) => b.type)).toEqual([
            'heading_1',
            'paragraph',
            'bulleted_list_item',
            'divider',
            'quote',
          ])
          expect(concatPlainText(tree[1]!)).toContain('bold')
        }),
      )
    },
    DEFAULT_TIMEOUT,
  )
})

/**
 * Nested-block children under list-ish / text-leaf parents. Notion's API
 * accepts `children: Block[]` on these types; the renderer must route block
 * children as fibers (not fold them into parent `rich_text`).
 */
describe.skipIf(SKIP_E2E)('nested block children under list-ish / text-leaf parents (e2e)', () => {
  const cases = [
    {
      label: 'bulleted_list_item',
      tree: (
        <Page>
          <BulletedListItem>
            parent
            <Paragraph>child</Paragraph>
          </BulletedListItem>
        </Page>
      ),
      parentType: 'bulleted_list_item',
    },
    {
      label: 'numbered_list_item',
      tree: (
        <Page>
          <NumberedListItem>
            parent
            <Paragraph>child</Paragraph>
          </NumberedListItem>
        </Page>
      ),
      parentType: 'numbered_list_item',
    },
    {
      label: 'to_do',
      tree: (
        <Page>
          <ToDo>
            parent
            <Paragraph>child</Paragraph>
          </ToDo>
        </Page>
      ),
      parentType: 'to_do',
    },
    {
      label: 'callout',
      tree: (
        <Page>
          <Callout icon="💡">
            parent
            <Paragraph>child</Paragraph>
          </Callout>
        </Page>
      ),
      parentType: 'callout',
    },
    {
      label: 'quote',
      tree: (
        <Page>
          <Quote>
            parent
            <Paragraph>child</Paragraph>
          </Quote>
        </Page>
      ),
      parentType: 'quote',
    },
    {
      label: 'paragraph',
      tree: (
        <Page>
          <Paragraph>
            parent
            <Paragraph>child</Paragraph>
          </Paragraph>
        </Page>
      ),
      parentType: 'paragraph',
    },
  ] as const

  for (const { label, tree, parentType } of cases) {
    it(
      `${label} — nested paragraph lands as block child (not rich_text)`,
      async () => {
        await withScratchPage(`nested-${label}`, (pageId) =>
          Effect.gen(function* () {
            yield* renderToNotion(tree, { pageId })
            const read = yield* readPageTree(pageId)
            const parent = read.find((b) => b.type === parentType)
            expect(parent, `expected parent ${parentType} on page`).toBeDefined()
            expect(firstPlainText(parent!)).toBe('parent')
            const child = parent!.children.find((c) => c.type === 'paragraph')
            expect(child, `expected nested paragraph under ${parentType}`).toBeDefined()
            expect(firstPlainText(child!)).toBe('child')
          }),
        )
      },
      DEFAULT_TIMEOUT,
    )
  }
})
