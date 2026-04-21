import type { ReactElement, ReactNode } from 'react'

import type {
  BookmarkProps,
  BulletedListItemProps,
  CalloutProps,
  CodeProps,
  ColorProps,
  ColumnListProps,
  ColumnProps,
  EmbedProps,
  EquationProps,
  HeadingProps,
  InlineAnnotationProps,
  InlineEquationProps,
  LinkProps,
  LinkToPageProps,
  MediaProps,
  MentionProps,
  NumberedListItemProps,
  PageProps,
  ParagraphProps,
  QuoteProps,
  TableOfContentsProps,
  TableProps,
  TableRowProps,
  ToDoProps,
  ToggleProps,
} from '../components/props.ts'

type BlockEl<TProps> = (props: TProps) => ReactElement | null
type InlineEl<TProps> = (props: TProps) => ReactNode

export interface DemoUi {
  readonly Page: BlockEl<PageProps>
  readonly Heading1: BlockEl<HeadingProps>
  readonly Heading2: BlockEl<HeadingProps>
  readonly Heading3: BlockEl<HeadingProps>
  readonly Heading4: BlockEl<HeadingProps>
  readonly Paragraph: BlockEl<ParagraphProps>
  readonly Callout: BlockEl<CalloutProps>
  readonly Table: BlockEl<TableProps>
  readonly TableRow: BlockEl<TableRowProps>
  readonly Toggle: BlockEl<ToggleProps>
  readonly BulletedListItem: BlockEl<BulletedListItemProps>
  readonly NumberedListItem: BlockEl<NumberedListItemProps>
  readonly Quote: BlockEl<QuoteProps>
  readonly Code: BlockEl<CodeProps>
  readonly Divider: BlockEl<Record<string, never>>
  readonly ToDo: BlockEl<ToDoProps>
  readonly ColumnList: BlockEl<ColumnListProps>
  readonly Column: BlockEl<ColumnProps>
  readonly Image: BlockEl<MediaProps>
  readonly Bookmark: BlockEl<BookmarkProps>
  readonly Embed: BlockEl<EmbedProps>
  readonly Equation: BlockEl<EquationProps>
  readonly LinkToPage: BlockEl<LinkToPageProps>
  readonly TableOfContents: BlockEl<TableOfContentsProps>
  readonly Bold: InlineEl<InlineAnnotationProps>
  readonly Italic: InlineEl<InlineAnnotationProps>
  readonly Strikethrough: InlineEl<InlineAnnotationProps>
  readonly Underline: InlineEl<InlineAnnotationProps>
  readonly InlineCode: InlineEl<InlineAnnotationProps>
  readonly Color: InlineEl<ColorProps>
  readonly Link: InlineEl<LinkProps>
  readonly Mention: InlineEl<MentionProps>
  readonly InlineEquation: InlineEl<InlineEquationProps>
}

export interface DemoContext {
  readonly parentPageId: string
  readonly pageIdsBySlug: ReadonlyMap<string, string>
}

type DemoEntry = {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly storyTitle: string
  readonly render: (ui: DemoUi, ctx?: DemoContext) => ReactElement
}

const DUMMY_PAGE_ID = '00000000-0000-4000-8000-000000000001'

export const emptyDemoContext: DemoContext = {
  parentPageId: DUMMY_PAGE_ID,
  pageIdsBySlug: new Map(),
}

const keyed = <T extends object>(
  props: T,
  blockKey: string,
): T & { readonly blockKey: string } => ({
  ...props,
  blockKey,
})

const pageIdFor = (ctx: DemoContext | undefined, slug: string): string =>
  ctx?.pageIdsBySlug.get(slug) ?? DUMMY_PAGE_ID

const colors = [
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
] as const

export const featuresIndexDemo: DemoEntry = {
  slug: 'features-index',
  title: 'Features Index',
  storyTitle: 'Demo/00 - Features Index',
  summary: 'Coverage map for the public demo suite with links into the main supported surfaces.',
  render: (ui, ctx = emptyDemoContext) => {
    const {
      Page,
      Heading1,
      Heading2,
      Paragraph,
      Divider,
      ColumnList,
      Column,
      BulletedListItem,
      LinkToPage,
      Italic,
    } = ui

    const basic = [
      'Basic blocks and rich text',
      'Lists and to-dos',
      'Code blocks in multiple languages',
      'Callout / inline color coverage',
    ]

    const advanced = [
      'Math and equation blocks',
      'Bookmarks, embeds, and image blocks',
      'Tables and column layouts',
      'Real page links and page mentions',
    ]

    const caveats = [
      'Root demo page itself shows real child_page rows',
      'Host-owned modern blocks are documented separately',
      'Unsupported stories are called out explicitly',
    ]

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>Features</Heading1>
        <Paragraph {...keyed({}, 'intro')}>
          <Italic>
            Public coverage page for the sync-safe notion-react surface. Every linked page below is
            published from the same shared demo catalog the sync script uses.
          </Italic>
        </Paragraph>
        <Divider />
        <ColumnList {...keyed({}, 'coverage-columns')}>
          <Column {...keyed({}, 'coverage-basic')}>
            <Heading2 {...keyed({}, 'basic-heading')}>Supported</Heading2>
            {basic.map((item, index) => (
              <BulletedListItem key={item} {...keyed({}, `basic-${index}`)}>
                {item}
              </BulletedListItem>
            ))}
          </Column>
          <Column {...keyed({}, 'coverage-advanced')}>
            <Heading2 {...keyed({}, 'advanced-heading')}>Advanced</Heading2>
            {advanced.map((item, index) => (
              <BulletedListItem key={item} {...keyed({}, `advanced-${index}`)}>
                {item}
              </BulletedListItem>
            ))}
          </Column>
          <Column {...keyed({}, 'coverage-caveats')}>
            <Heading2 {...keyed({}, 'caveats-heading')}>Notes</Heading2>
            {caveats.map((item, index) => (
              <BulletedListItem key={item} {...keyed({}, `caveat-${index}`)}>
                {item}
              </BulletedListItem>
            ))}
          </Column>
        </ColumnList>
        <Heading2 {...keyed({}, 'jump-heading')}>Jump to key pages</Heading2>
        <LinkToPage pageId={pageIdFor(ctx, 'basic-blocks')} />
        <LinkToPage pageId={pageIdFor(ctx, 'links-and-navigation')} />
        <LinkToPage pageId={pageIdFor(ctx, 'media-and-layout')} />
        <LinkToPage pageId={pageIdFor(ctx, 'coverage-gaps')} />
      </Page>
    )
  },
}

export const basicBlocksDemo: DemoEntry = {
  slug: 'basic-blocks',
  title: 'Basic Blocks',
  storyTitle: 'Blocks/* + Demo/01 - Basic Blocks',
  summary:
    'Headings, annotation-rich paragraphs, dividers, quotes, callouts, and toggleable headings.',
  render: (ui) => {
    const {
      Page,
      Heading1,
      Heading2,
      Heading3,
      Heading4,
      Paragraph,
      Quote,
      Divider,
      Callout,
      Bold,
      Italic,
      Underline,
      Strikethrough,
      InlineCode,
      Link,
    } = ui

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>Basic blocks</Heading1>
        <Paragraph {...keyed({}, 'intro')}>
          This paragraph exercises <Bold>bold</Bold>, <Italic>italic</Italic>,{' '}
          <Underline>underline</Underline>, <Strikethrough>strikethrough</Strikethrough>, and{' '}
          <InlineCode>inline code</InlineCode>. It also carries an inline{' '}
          <Link href="https://notion.so">link</Link>.
        </Paragraph>
        <Heading2 {...keyed({}, 'h2')}>Section heading</Heading2>
        <Paragraph {...keyed({}, 'h2-body')}>
          Headings preserve the expected hierarchy and sync incrementally when text or color
          changes.
        </Paragraph>
        <Heading2 {...keyed({ toggleable: true }, 'h2-toggleable')}>Toggleable heading</Heading2>
        <Heading3 {...keyed({ color: 'blue' }, 'h3-blue')}>Colored subsection</Heading3>
        <Paragraph {...keyed({}, 'h3-body')}>
          Blue heading color projects through both the web renderer and Notion sync.
        </Paragraph>
        <Heading4 {...keyed({ color: 'red_background' }, 'h4-red-bg')}>
          Heading 4 with background color
        </Heading4>
        <Paragraph {...keyed({}, 'h4-body')}>
          Heading 4 is part of the supported host surface and published demo coverage.
        </Paragraph>
        <Callout {...keyed({ icon: '💡', color: 'yellow_background' }, 'callout')}>
          Tip: stable <InlineCode>blockKey</InlineCode> values keep warm sync incremental even as
          pages evolve.
        </Callout>
        <Divider />
        <Quote {...keyed({}, 'quote')}>
          A block quote is a short passage from another source, offset from surrounding prose.
        </Quote>
      </Page>
    )
  },
}

export const listsAndTodosDemo: DemoEntry = {
  slug: 'lists-and-todos',
  title: 'Lists and To-dos',
  storyTitle: 'Blocks/BulletedList + Blocks/NumberedList + Blocks/ToDoList + Demo/02 - Lists',
  summary: 'Bulleted lists, numbered lists, checked tasks, and stack-style nesting guidance.',
  render: (ui) => {
    const {
      Page,
      Heading1,
      Heading2,
      Paragraph,
      BulletedListItem,
      NumberedListItem,
      ToDo,
      Callout,
      Bold,
    } = ui

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>Lists</Heading1>
        <Heading2 {...keyed({}, 'bulleted-heading')}>Bulleted</Heading2>
        <BulletedListItem {...keyed({}, 'bullet-1')}>Apples</BulletedListItem>
        <BulletedListItem {...keyed({}, 'bullet-2')}>
          Oranges with <Bold>emphasis</Bold>
        </BulletedListItem>
        <BulletedListItem {...keyed({}, 'bullet-3')}>Bananas</BulletedListItem>

        <Heading2 {...keyed({}, 'numbered-heading')}>Numbered</Heading2>
        <NumberedListItem {...keyed({}, 'step-1')}>Gather ingredients</NumberedListItem>
        <NumberedListItem {...keyed({}, 'step-2')}>Preheat oven to 180 C</NumberedListItem>
        <NumberedListItem {...keyed({}, 'step-3')}>Bake for 25 minutes</NumberedListItem>

        <Heading2 {...keyed({}, 'todo-heading')}>To-do</Heading2>
        <ToDo {...keyed({ checked: true }, 'todo-1')}>Write spec</ToDo>
        <ToDo {...keyed({ checked: true }, 'todo-2')}>Implement renderer</ToDo>
        <ToDo {...keyed({}, 'todo-3')}>Publish changelog</ToDo>

        <Heading2 {...keyed({}, 'nesting-heading')}>Nesting guidance</Heading2>
        <Callout {...keyed({ icon: 'ℹ️', color: 'gray_background' }, 'nesting-callout')}>
          v0.1 treats list items as sibling blocks. When you need hierarchy today, stack keyed
          siblings instead of relying on deep nested children.
        </Callout>
        <Paragraph {...keyed({}, 'stacked-label')}>Stacked approximation:</Paragraph>
        <BulletedListItem {...keyed({}, 'stack-1')}>Fruit</BulletedListItem>
        <BulletedListItem {...keyed({}, 'stack-2')}>- Apples</BulletedListItem>
        <BulletedListItem {...keyed({}, 'stack-3')}>- Oranges</BulletedListItem>
      </Page>
    )
  },
}

export const codeBlocksDemo: DemoEntry = {
  slug: 'code-blocks',
  title: 'Code Blocks',
  storyTitle: 'Blocks/CodeBlock + Demo/04 - Code Blocks',
  summary: 'Code blocks across multiple languages with stable block identity.',
  render: (ui) => {
    const { Page, Heading1, Heading2, Paragraph, Code } = ui

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>Code blocks</Heading1>
        <Paragraph {...keyed({}, 'intro')}>
          Language-tagged code blocks are fully sync-safe and diff at block granularity.
        </Paragraph>

        <Heading2 {...keyed({}, 'ts-heading')}>TypeScript</Heading2>
        <Code {...keyed({ language: 'typescript' }, 'ts-code')}>{`type Shape =
  | { _tag: 'circle'; radius: number }
  | { _tag: 'square'; side: number }

const area = (s: Shape): number => {
  switch (s._tag) {
    case 'circle': return Math.PI * s.radius ** 2
    case 'square': return s.side * s.side
  }
}`}</Code>

        <Heading2 {...keyed({}, 'py-heading')}>Python</Heading2>
        <Code {...keyed({ language: 'python' }, 'py-code')}>{`def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

print([fib(i) for i in range(10)])`}</Code>

        <Heading2 {...keyed({}, 'bash-heading')}>Bash</Heading2>
        <Code
          {...keyed({ language: 'bash' }, 'bash-code')}
        >{`pnpm --filter @overeng/notion-react storybook:build
pnpm --filter @overeng/notion-react exec vitest run`}</Code>
      </Page>
    )
  },
}

export const colorsAndInlineDemo: DemoEntry = {
  slug: 'colors-and-inline',
  title: 'Colors and Inline',
  storyTitle: 'Inline/* + Demo/03 - Color Rainbow + Demo/19 - Modern Color Palette',
  summary: 'Foreground and background inline colors plus the full callout color palette.',
  render: (ui) => {
    const { Page, Heading1, Heading2, Paragraph, Callout, Color, InlineCode } = ui

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>Colors and inline</Heading1>
        <Heading2 {...keyed({}, 'fg-heading')}>Foreground</Heading2>
        {colors.map((color, index) => (
          <Paragraph key={color} {...keyed({}, `fg-${index}`)}>
            <Color value={color}>
              The quick brown fox jumps over the lazy dog - <InlineCode>{color}</InlineCode>
            </Color>
          </Paragraph>
        ))}

        <Heading2 {...keyed({}, 'bg-heading')}>Background</Heading2>
        {colors
          .filter((color) => color !== 'default')
          .map((color, index) => (
            <Paragraph key={`${color}-bg`} {...keyed({}, `bg-${index}`)}>
              <Color value={`${color}_background`}>
                The quick brown fox jumps over the lazy dog -{' '}
                <InlineCode>{`${color}_background`}</InlineCode>
              </Color>
            </Paragraph>
          ))}

        <Heading2 {...keyed({}, 'callout-heading')}>Callout color swatches</Heading2>
        {colors.map((color, index) => (
          <Callout key={`callout-${color}`} {...keyed({ icon: '🎨', color }, `callout-${index}`)}>
            Callout color <InlineCode>{color}</InlineCode>
          </Callout>
        ))}
      </Page>
    )
  },
}

export const linksAndNavigationDemo: DemoEntry = {
  slug: 'links-and-navigation',
  title: 'Links and Navigation',
  storyTitle: 'Inline/Links + Inline/Mentions + Demo/07 - Links + Media & Layout/Navigation',
  summary:
    'Inline links, page mentions, date mentions, actual link_to_page rows, and TOC coverage.',
  render: (ui, ctx = emptyDemoContext) => {
    const {
      Page,
      Heading1,
      Heading2,
      Heading3,
      Paragraph,
      TableOfContents,
      LinkToPage,
      Link,
      InlineCode,
      Mention,
    } = ui

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>Links and navigation</Heading1>
        <Paragraph {...keyed({}, 'intro')}>
          This page uses real page IDs for block links and page mentions during published syncs.
        </Paragraph>
        <TableOfContents />

        <Heading2 {...keyed({}, 'inline-links-heading')}>Inline links</Heading2>
        <Paragraph {...keyed({}, 'inline-links-body')}>
          Visit <Link href="https://notion.so">notion.so</Link> or browse the{' '}
          <Link href="https://github.com/overengineeringstudio/effect-utils">
            effect-utils repo
          </Link>
          . Links can wrap{' '}
          <Link href="https://example.com/docs">
            <InlineCode>inline code</InlineCode>
          </Link>
          .
        </Paragraph>

        <Heading2 {...keyed({}, 'mentions-heading')}>Mentions</Heading2>
        <Paragraph {...keyed({}, 'mentions-body')}>
          Page mention:{' '}
          <Mention
            mention={{ type: 'page', page: { id: pageIdFor(ctx, 'launch-overview') } }}
            plainText="@Launch Overview"
          />
          . Date mention:{' '}
          <Mention
            mention={{ type: 'date', date: { start: '2026-04-21' } }}
            plainText="@2026-04-21"
          />
          .
        </Paragraph>

        <Heading2 {...keyed({}, 'page-links-heading')}>link_to_page blocks</Heading2>
        <LinkToPage pageId={pageIdFor(ctx, 'launch-overview')} />
        <LinkToPage pageId={pageIdFor(ctx, 'team-update')} />
        <LinkToPage pageId={pageIdFor(ctx, 'tradeoffs-section')} />

        <Heading3 {...keyed({}, 'root-child-page-heading')}>child_page rows</Heading3>
        <Paragraph {...keyed({}, 'root-child-page-body')}>
          The root public demo page itself is the live child_page showcase. It lists every synced
          child page under the shared container page.
        </Paragraph>
      </Page>
    )
  },
}

export const mathAndEquationsDemo: DemoEntry = {
  slug: 'math-and-equations',
  title: 'Math and Equations',
  storyTitle: 'Inline/Equations + Demo/08 - Math and Equations + Media & Layout/EquationBlock',
  summary: 'Inline equations and block equations rendered through the shared Notion surface.',
  render: (ui) => {
    const { Page, Heading1, Heading2, Paragraph, Equation, InlineEquation } = ui

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>Math and equations</Heading1>
        <Heading2 {...keyed({}, 'inline-heading')}>Inline</Heading2>
        <Paragraph {...keyed({}, 'inline-body')}>
          Euler&apos;s identity <InlineEquation expression="e^{i\\pi} + 1 = 0" /> and the
          Pythagorean theorem <InlineEquation expression="a^2 + b^2 = c^2" /> are both projected as
          rich-text equations.
        </Paragraph>

        <Heading2 {...keyed({}, 'block-heading')}>Block</Heading2>
        <Equation expression="\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}" />
        <Equation expression="\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}" />
        <Equation expression="\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} \\cdot \\begin{pmatrix} x \\\\ y \\end{pmatrix} = \\begin{pmatrix} ax + by \\\\ cx + dy \\end{pmatrix}" />
      </Page>
    )
  },
}

export const mediaAndLayoutDemo: DemoEntry = {
  slug: 'media-and-layout',
  title: 'Media and Layout',
  storyTitle:
    'Media & Layout/* + Demo/06 - Bookmarks + Demo/09 - Column Layouts + Demo/12 - Modern Column Widths + Demo/15 - Modern File Upload',
  summary: 'Image, bookmark, embed, table, and column layout coverage.',
  render: (ui) => {
    const {
      Page,
      Heading1,
      Heading2,
      Heading3,
      Paragraph,
      Image,
      Bookmark,
      Embed,
      Table,
      TableRow,
      ColumnList,
      Column,
      Callout,
    } = ui

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>Media and layout</Heading1>

        <Heading2 {...keyed({}, 'image-heading')}>Image</Heading2>
        <Image
          url="https://images.unsplash.com/photo-1523961131990-5ea7c61b2107?w=800&q=80"
          caption="A tree, in a forest, near a river"
        />

        <Heading2 {...keyed({}, 'bookmark-heading')}>Bookmark and embed</Heading2>
        <Bookmark url="https://notion.so" />
        <Embed url="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />

        <Heading2 {...keyed({}, 'table-heading')}>Simple table</Heading2>
        <Table {...keyed({ tableWidth: 3, hasColumnHeader: true }, 'table')}>
          <TableRow cells={['Tier', 'Price', 'Highlight']} />
          <TableRow cells={['Nimbus One', '$89', 'Core dimming + app control']} />
          <TableRow cells={['Nimbus Plus', '$129', 'Adds color temperature']} />
          <TableRow cells={['Nimbus Pro', '$179', 'Full RGB + scenes']} />
        </Table>

        <Heading2 {...keyed({}, 'columns-heading')}>Columns and width ratios</Heading2>
        <ColumnList {...keyed({}, 'columns')}>
          <Column {...keyed({}, 'col-left')}>
            <Heading3 {...keyed({}, 'col-left-heading')}>Primary column</Heading3>
            <Paragraph {...keyed({}, 'col-left-body')}>
              Two-column layouts are sync-safe and render incrementally as ordinary column children.
            </Paragraph>
          </Column>
          <Column {...keyed({}, 'col-right')}>
            <Heading3 {...keyed({}, 'col-right-heading')}>Sidebar</Heading3>
            <Paragraph {...keyed({}, 'col-right-body')}>
              Width ratios are intentionally omitted here because Notion does not currently accept
              them on append via the public API.
            </Paragraph>
          </Column>
        </ColumnList>

        <Callout {...keyed({ icon: '✅', color: 'green_background' }, 'width-ratio-callout')}>
          Bookmarks, embeds, tables, images, and plain column layouts are all part of the sync-safe
          public demo contract.
        </Callout>
      </Page>
    )
  },
}

export const coverageGapsDemo: DemoEntry = {
  slug: 'coverage-gaps',
  title: 'Coverage Gaps and Host-owned Blocks',
  storyTitle: 'Demo/10 - Placeholders + Modern Raw stories',
  summary:
    'Explicitly documents the Storybook stories that are intentionally not part of the synced public demo.',
  render: (ui) => {
    const { Page, Heading1, Heading2, Paragraph, Callout, BulletedListItem, InlineCode } = ui

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>Coverage gaps and host-owned blocks</Heading1>
        <Paragraph {...keyed({}, 'intro')}>
          The public demo aims for full coverage of the supported sync-safe surface. The stories
          below remain excluded on purpose so the page does not pretend unsupported host-owned
          blocks are production-ready.
        </Paragraph>

        <Heading2 {...keyed({}, 'raw-heading')}>Raw / passthrough stories</Heading2>
        <BulletedListItem {...keyed({}, 'raw-1')}>
          Tabs, synced blocks, link previews, meeting notes, breadcrumb, and child database stories
          still rely on <InlineCode>Raw</InlineCode> or server-owned payloads.
        </BulletedListItem>
        <BulletedListItem {...keyed({}, 'raw-2')}>
          They are valuable Storybook references, but not good public examples of incremental sync.
        </BulletedListItem>

        <Heading2 {...keyed({}, 'unsafe-heading')}>Fake-ID stories</Heading2>
        <BulletedListItem {...keyed({}, 'unsafe-1')}>
          Web-only stories that use fake page, database, or user IDs are not synced verbatim because
          Notion rejects invalid references.
        </BulletedListItem>
        <BulletedListItem {...keyed({}, 'unsafe-2')}>
          The public demo uses real page mentions and real link_to_page rows instead.
        </BulletedListItem>

        <Heading2 {...keyed({}, 'media-gap-heading')}>Upload-backed media</Heading2>
        <BulletedListItem {...keyed({}, 'media-gap-1')}>
          Notion rejects external URLs on create for <InlineCode>video</InlineCode>,{' '}
          <InlineCode>audio</InlineCode>, <InlineCode>file</InlineCode>, and{' '}
          <InlineCode>pdf</InlineCode> blocks.
        </BulletedListItem>
        <BulletedListItem {...keyed({}, 'media-gap-2')}>
          Those block types need the <InlineCode>file_upload</InlineCode> pipeline before they
          belong in the public sync demo.
        </BulletedListItem>

        <Heading2 {...keyed({}, 'column-gap-heading')}>Column width ratios</Heading2>
        <BulletedListItem {...keyed({}, 'column-gap-1')}>
          <InlineCode>widthRatio</InlineCode> is implemented locally in the prop surface and host
          projection, but Notion currently rejects it on append through the public API.
        </BulletedListItem>
        <BulletedListItem {...keyed({}, 'column-gap-2')}>
          The public demo therefore covers plain column layouts, while width-ratio experimentation
          stays in Storybook and unit tests until live API support is proven.
        </BulletedListItem>

        <Callout {...keyed({ icon: '🚧', color: 'yellow_background' }, 'callout')}>
          This page is the contract: supported public demo coverage should expand by replacing these
          caveats with first-class synced examples, not by publishing brittle placeholders.
        </Callout>
      </Page>
    )
  },
}

export const launchOverviewDemo: DemoEntry = {
  slug: 'launch-overview',
  title: 'Launch Overview',
  storyTitle: 'Pages/LaunchOverview',
  summary: 'A launch-plan page with tables, keyed toggles, rich text, and timeline entries.',
  render: (ui) => {
    const {
      Page,
      Heading1,
      Heading2,
      Paragraph,
      Callout,
      Table,
      TableRow,
      Toggle,
      BulletedListItem,
      Bold,
      InlineCode,
      Link,
      Italic,
    } = ui

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>Q2 Launch · Nimbus Smart Lamp</Heading1>
        <Callout {...keyed({ icon: '🎯', color: 'gray_background' }, 'ship-callout')}>
          <Bold>Ship date:</Bold> June 3 · <Bold>Units:</Bold> 10,000 · <Bold>Markets:</Bold> US, EU
        </Callout>
        <Heading2 {...keyed({}, 'pricing-heading')}>Pricing tiers</Heading2>
        <Table {...keyed({ tableWidth: 3, hasColumnHeader: true }, 'pricing-tiers')}>
          <TableRow cells={['Tier', 'Price', 'Highlight']} />
          <TableRow cells={['Nimbus One', '$89', 'Core dimming + app control']} />
          <TableRow cells={['Nimbus Plus', '$129', 'Adds color temperature']} />
          <TableRow cells={['Nimbus Pro', '$179', 'Full RGB + scenes']} />
        </Table>
        <Heading2 {...keyed({}, 'phases-heading')}>Phases</Heading2>
        <Toggle {...keyed({ title: 'Phase 1 — Manufacturing (April)' }, 'phase-1')}>
          <Paragraph {...keyed({}, 'phase-1-body')}>
            First production run of <InlineCode>5,000</InlineCode> units. QA pass-rate target 98%.
          </Paragraph>
          <BulletedListItem {...keyed({}, 'phase-1-memo')}>
            Factory sign-off memo <Link href="https://example.com/memo">linked here</Link>
          </BulletedListItem>
          <BulletedListItem {...keyed({}, 'phase-1-fw')}>Firmware v1.0.3 locked</BulletedListItem>
        </Toggle>
        <Toggle {...keyed({ title: 'Phase 2 — Marketing (May)' }, 'phase-2')}>
          <Paragraph {...keyed({}, 'phase-2-body')}>
            Press kit, launch video, influencer seeding.
          </Paragraph>
        </Toggle>
        <Heading2 {...keyed({}, 'timeline-heading')}>Timeline</Heading2>
        <Paragraph {...keyed({}, 'timeline-1')}>
          April 10 · <Italic>planning</Italic> — finalized SKU matrix.
        </Paragraph>
        <Paragraph {...keyed({}, 'timeline-2')}>
          April 19 · <Italic>review</Italic> — sign-off from <Italic>@priya</Italic>.
        </Paragraph>
        <Paragraph {...keyed({}, 'timeline-3')}>
          May 02 · <Italic>marketing</Italic> — embargo lifts, press briefings begin.
        </Paragraph>
      </Page>
    )
  },
}

export const teamUpdateDemo: DemoEntry = {
  slug: 'team-update',
  title: 'Team Update',
  storyTitle: 'Pages/TeamUpdate',
  summary: 'A compact weekly update page with wins, risks, quote, and next-step tasks.',
  render: (ui) => {
    const {
      Page,
      Heading1,
      Heading3,
      Paragraph,
      BulletedListItem,
      Quote,
      Divider,
      ToDo,
      Bold,
      Italic,
    } = ui

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>Launch Update · Friday, April 19 2026</Heading1>
        <Paragraph {...keyed({}, 'summary')}>
          Manufacturing is <Bold>on track</Bold>. First 500 units cleared QA this morning with a 99%
          pass rate — above target. Marketing kicks off next week.
        </Paragraph>
        <Heading3 {...keyed({}, 'wins-heading')}>Wins</Heading3>
        <BulletedListItem {...keyed({}, 'win-qa')}>
          QA pass rate above target (99% vs 98%)
        </BulletedListItem>
        <BulletedListItem {...keyed({}, 'win-legal')}>
          Press kit approved by legal on the first pass
        </BulletedListItem>
        <Heading3 {...keyed({}, 'risks-heading')}>Risks</Heading3>
        <BulletedListItem {...keyed({}, 'risk-packaging')}>
          Packaging supplier is quoting two extra weeks — contingency plan in progress.
        </BulletedListItem>
        <Heading3 {...keyed({}, 'quote-heading')}>Quote of the week</Heading3>
        <Quote {...keyed({}, 'quote')}>
          The best launches are <Italic>boring</Italic> launches.
        </Quote>
        <Divider />
        <Heading3 {...keyed({}, 'next-heading')}>Next</Heading3>
        <ToDo {...keyed({}, 'todo-supplier')}>Confirm packaging backup supplier by Wednesday</ToDo>
        <ToDo {...keyed({}, 'todo-press')}>Share press kit with wave-1 publications</ToDo>
        <ToDo {...keyed({}, 'todo-pricing')}>Lock final pricing for Nimbus Plus</ToDo>
      </Page>
    )
  },
}

export const tradeoffsSectionDemo: DemoEntry = {
  slug: 'tradeoffs-section',
  title: 'Tradeoffs Section',
  storyTitle: 'Pages/TradeoffsSection',
  summary: 'A tradeoff log with TOC, callouts, code, columns, and a product image.',
  render: (ui) => {
    const {
      Page,
      Heading1,
      Heading2,
      Heading3,
      Paragraph,
      TableOfContents,
      Callout,
      NumberedListItem,
      Code,
      Divider,
      ColumnList,
      Column,
      Image,
      Bold,
      InlineCode,
    } = ui

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>Tradeoffs</Heading1>
        <TableOfContents />
        <Heading2 {...keyed({}, 't001-title')}>
          T-001 · Launch with three tiers instead of two
        </Heading2>
        <Paragraph {...keyed({}, 't001-meta')}>
          <Bold>Status:</Bold> accepted · <Bold>Date:</Bold> 2026-04-12
        </Paragraph>
        <Heading3 {...keyed({}, 't001-context-heading')}>Context</Heading3>
        <Paragraph {...keyed({}, 't001-context')}>
          Market research showed two distinct price-sensitive segments. A single mid-tier SKU would
          have left both margin on the table and low-end volume uncaptured.
        </Paragraph>
        <Heading3 {...keyed({}, 't001-decision-heading')}>Decision</Heading3>
        <Callout {...keyed({ icon: '✅', color: 'green_background' }, 't001-decision')}>
          Ship <InlineCode>One</InlineCode>, <InlineCode>Plus</InlineCode>, and{' '}
          <InlineCode>Pro</InlineCode> tiers at $89 / $129 / $179.
        </Callout>
        <Heading3 {...keyed({}, 't001-consequences-heading')}>Consequences</Heading3>
        <NumberedListItem {...keyed({}, 't001-c1')}>
          Three SKUs to manage in inventory and marketing
        </NumberedListItem>
        <NumberedListItem {...keyed({}, 't001-c2')}>
          Clearer upsell path from One → Plus → Pro
        </NumberedListItem>
        <NumberedListItem {...keyed({}, 't001-c3')}>
          Packaging cost up 4% due to per-SKU artwork
        </NumberedListItem>
        <Heading3 {...keyed({}, 't001-code-heading')}>Pricing snippet</Heading3>
        <Code {...keyed({ language: 'typescript' }, 't001-code')}>{`const pricing = {
  one: 89,
  plus: 129,
  pro: 179,
} as const`}</Code>
        <Divider />
        <Heading2 {...keyed({}, 't002-title')}>T-002 · Delay EU launch by two weeks</Heading2>
        <Paragraph {...keyed({}, 't002-body')}>
          Regulatory review on the wireless module came back with minor labelling asks. Safer to
          batch the fix than ship twice.
        </Paragraph>
        <ColumnList {...keyed({}, 't002-columns')}>
          <Column {...keyed({}, 't002-before')}>
            <Heading3 {...keyed({}, 't002-before-heading')}>Before</Heading3>
            <Paragraph {...keyed({}, 't002-before-body')}>
              Simultaneous US + EU launch on June 3.
            </Paragraph>
          </Column>
          <Column {...keyed({}, 't002-after')}>
            <Heading3 {...keyed({}, 't002-after-heading')}>After</Heading3>
            <Paragraph {...keyed({}, 't002-after-body')}>
              US on <InlineCode>June 3</InlineCode>, EU on <InlineCode>June 17</InlineCode>.
            </Paragraph>
          </Column>
        </ColumnList>
        <Heading3 {...keyed({}, 'product-shot-heading')}>Product shot</Heading3>
        <Image
          url="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=80"
          caption="Nimbus Smart Lamp — studio reference"
        />
      </Page>
    )
  },
}

export const notionPageDemos = [
  featuresIndexDemo,
  basicBlocksDemo,
  listsAndTodosDemo,
  codeBlocksDemo,
  colorsAndInlineDemo,
  linksAndNavigationDemo,
  mathAndEquationsDemo,
  mediaAndLayoutDemo,
  coverageGapsDemo,
  launchOverviewDemo,
  teamUpdateDemo,
  tradeoffsSectionDemo,
] as const

export const renderDemoBySlug = (
  slug: string,
  ui: DemoUi,
  ctx: DemoContext = emptyDemoContext,
): ReactElement => {
  const demo = notionPageDemos.find((entry) => entry.slug === slug)
  if (demo === undefined) {
    throw new Error(`Unknown notion demo slug: ${slug}`)
  }
  return demo.render(ui, ctx)
}

export const buildDemoLandingSummary = (entries: readonly DemoEntry[]): ReactNode =>
  entries.map((entry) => entry.title).join(', ')
