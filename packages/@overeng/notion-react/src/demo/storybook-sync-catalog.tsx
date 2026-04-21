import type { ReactElement } from 'react'

import {
  basicBlocksDemo,
  codeBlocksDemo,
  type DemoContext,
  emptyDemoContext,
  type DemoUi,
  featuresIndexDemo,
  launchOverviewDemo,
  linksAndNavigationDemo,
  listsAndTodosDemo,
  mathAndEquationsDemo,
  teamUpdateDemo,
  tradeoffsSectionDemo,
} from './page-demos.tsx'

export interface StorybookSyncPage {
  readonly slug: string
  readonly title: string
  readonly parentSlug?: string
  readonly aliases?: readonly string[]
  readonly render?: (ui: DemoUi, ctx?: DemoContext) => ReactElement
}

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

const keyed = <T extends object>(
  props: T,
  blockKey: string,
): T & { readonly blockKey: string } => ({
  ...props,
  blockKey,
})

const pageIdFor = (ctx: DemoContext | undefined, slug: string): string =>
  ctx?.pageIdsBySlug.get(slug) ?? emptyDemoContext.parentPageId

const placeholderPage =
  (title: string, summary: string, issue: string) =>
  (ui: DemoUi): ReactElement => {
    const { Page, Heading1, Paragraph, Callout, InlineCode } = ui

    return (
      <Page>
        <Heading1 {...keyed({}, 'title')}>{title}</Heading1>
        <Paragraph {...keyed({}, 'summary')}>{summary}</Paragraph>
        <Callout {...keyed({ icon: '🚧', color: 'yellow_background' }, 'callout')}>
          Live public sync is not ready for this story yet. Tracked by{' '}
          <InlineCode>{issue}</InlineCode>.
        </Callout>
      </Page>
    )
  }

const blocksCategoryPage = (ui: DemoUi, ctx = emptyDemoContext): ReactElement => {
  const { Page, Heading1, Paragraph, Heading2, BulletedListItem, LinkToPage, Callout, Bold } = ui

  return (
    <Page>
      <Heading1 {...keyed({}, 'title')}>Blocks</Heading1>
      <Paragraph {...keyed({}, 'summary')}>
        This page mirrors the Storybook <Bold>Blocks</Bold> group at the information-architecture
        level. The live Notion demo keeps the public examples focused on sync-safe, rerunnable
        pages.
      </Paragraph>
      <Heading2 {...keyed({}, 'stories-heading')}>Storybook stories</Heading2>
      {[
        'Headings',
        'Paragraphs',
        'BulletedList',
        'NumberedList',
        'ToDoList',
        'ToggleBlock',
        'CodeBlock',
        'QuoteBlock',
        'CalloutBlock',
        'DividerBlock',
      ].map((story, index) => (
        <BulletedListItem key={story} {...keyed({}, `story-${index}`)}>
          {story}
        </BulletedListItem>
      ))}
      <Heading2 {...keyed({}, 'live-heading')}>Live synced reference pages</Heading2>
      <LinkToPage pageId={pageIdFor(ctx, 'demo-01-basic-blocks')} />
      <LinkToPage pageId={pageIdFor(ctx, 'demo-02-lists')} />
      <LinkToPage pageId={pageIdFor(ctx, 'demo-04-code-blocks')} />
      <Callout {...keyed({ icon: 'ℹ️', color: 'gray_background' }, 'callout')}>
        The category structure now matches Storybook. Individual block reference stories remain
        owned by Storybook; the public Notion pages focus on end-to-end sync-safe examples.
      </Callout>
    </Page>
  )
}

const inlineCategoryPage = (ui: DemoUi, ctx = emptyDemoContext): ReactElement => {
  const { Page, Heading1, Paragraph, Heading2, BulletedListItem, LinkToPage } = ui

  return (
    <Page>
      <Heading1 {...keyed({}, 'title')}>Inline</Heading1>
      <Paragraph {...keyed({}, 'summary')}>
        Storybook&apos;s inline surface covers annotations, colors, links, mentions, and equations.
        The public Notion demo maps those capabilities to a smaller set of rerunnable pages.
      </Paragraph>
      <Heading2 {...keyed({}, 'stories-heading')}>Storybook stories</Heading2>
      {['Annotations', 'Colors', 'Links', 'Mentions', 'Equations'].map((story, index) => (
        <BulletedListItem key={story} {...keyed({}, `story-${index}`)}>
          {story}
        </BulletedListItem>
      ))}
      <Heading2 {...keyed({}, 'live-heading')}>Live synced reference pages</Heading2>
      <LinkToPage pageId={pageIdFor(ctx, 'demo-03-color-rainbow')} />
      <LinkToPage pageId={pageIdFor(ctx, 'demo-07-links')} />
      <LinkToPage pageId={pageIdFor(ctx, 'demo-08-math-equations')} />
      <LinkToPage pageId={pageIdFor(ctx, 'demo-19-modern-color-palette')} />
    </Page>
  )
}

const mediaLayoutCategoryPage = (ui: DemoUi, ctx = emptyDemoContext): ReactElement => {
  const { Page, Heading1, Paragraph, Heading2, BulletedListItem, LinkToPage, Callout } = ui

  return (
    <Page>
      <Heading1 {...keyed({}, 'title')}>Media & Layout</Heading1>
      <Paragraph {...keyed({}, 'summary')}>
        Storybook groups media blocks, tables, columns, navigation helpers, and modern host-owned
        surfaces under one category. The pages linked below separate sync-safe examples from the
        placeholder stories that still depend on host-owned payloads.
      </Paragraph>
      <Heading2 {...keyed({}, 'stories-heading')}>Storybook stories</Heading2>
      {['ImageBlock', 'BookmarkEmbed', 'EquationBlock', 'TableBlock', 'Columns', 'Navigation'].map(
        (story, index) => (
          <BulletedListItem key={story} {...keyed({}, `story-${index}`)}>
            {story}
          </BulletedListItem>
        ),
      )}
      <Heading2 {...keyed({}, 'live-heading')}>Live synced reference pages</Heading2>
      <LinkToPage pageId={pageIdFor(ctx, 'demo-05-table-of-contents')} />
      <LinkToPage pageId={pageIdFor(ctx, 'demo-06-bookmarks')} />
      <LinkToPage pageId={pageIdFor(ctx, 'demo-09-column-layouts')} />
      <LinkToPage pageId={pageIdFor(ctx, 'demo-18-modern-child-db-page')} />
      <Callout {...keyed({ icon: 'ℹ️', color: 'gray_background' }, 'callout')}>
        Stories that rely on modern Notion-owned payloads stay documented as placeholders so the
        public page does not over-claim live support.
      </Callout>
    </Page>
  )
}

const colorRainbowPage = (ui: DemoUi): ReactElement => {
  const { Page, Heading1, Heading2, Paragraph, Color, InlineCode } = ui

  return (
    <Page>
      <Heading1 {...keyed({}, 'title')}>Color rainbow</Heading1>
      <Heading2 {...keyed({}, 'fg-heading')}>Foreground colors</Heading2>
      {colors.map((color, index) => (
        <Paragraph key={color} {...keyed({}, `fg-${index}`)}>
          <Color value={color}>
            The quick brown fox jumps over the lazy dog. <InlineCode>{color}</InlineCode>
          </Color>
        </Paragraph>
      ))}
      <Heading2 {...keyed({}, 'bg-heading')}>Background colors</Heading2>
      {colors
        .filter((color) => color !== 'default')
        .map((color, index) => (
          <Paragraph key={`${color}-bg`} {...keyed({}, `bg-${index}`)}>
            <Color value={`${color}_background`}>
              The quick brown fox jumps over the lazy dog.{' '}
              <InlineCode>{`${color}_background`}</InlineCode>
            </Color>
          </Paragraph>
        ))}
    </Page>
  )
}

const tableOfContentsPage = (ui: DemoUi): ReactElement => {
  const { Page, Heading1, Heading2, Heading3, Paragraph, TableOfContents } = ui

  return (
    <Page>
      <Heading1 {...keyed({}, 'title')}>Table of contents</Heading1>
      <Paragraph {...keyed({}, 'summary')}>
        The table of contents is generated from the surrounding heading structure on the page.
      </Paragraph>
      <TableOfContents />
      <Heading2 {...keyed({}, 'section-a')}>Overview</Heading2>
      <Paragraph {...keyed({}, 'section-a-body')}>
        A compact example page with enough heading depth for a useful table of contents.
      </Paragraph>
      <Heading2 {...keyed({}, 'section-b')}>API notes</Heading2>
      <Heading3 {...keyed({}, 'section-b-1')}>Heading extraction</Heading3>
      <Paragraph {...keyed({}, 'section-b-1-body')}>
        The web renderer collects headings around the TOC marker; the Notion sync projects the same
        block shape.
      </Paragraph>
      <Heading3 {...keyed({}, 'section-b-2')}>Incremental sync</Heading3>
      <Paragraph {...keyed({}, 'section-b-2-body')}>
        Stable block keys keep the TOC page incremental as sections are edited over time.
      </Paragraph>
    </Page>
  )
}

const bookmarksPage = (ui: DemoUi): ReactElement => {
  const { Page, Heading1, Paragraph, Bookmark, Embed } = ui

  return (
    <Page>
      <Heading1 {...keyed({}, 'title')}>Bookmarks</Heading1>
      <Paragraph {...keyed({}, 'summary')}>
        Bookmark and embed blocks are live sync-safe today when backed by ordinary external URLs.
      </Paragraph>
      <Bookmark url="https://notion.so" />
      <Embed url="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />
    </Page>
  )
}

const columnLayoutsPage = (ui: DemoUi): ReactElement => {
  const { Page, Heading1, Heading2, Heading3, Paragraph, ColumnList, Column, Callout } = ui

  return (
    <Page>
      <Heading1 {...keyed({}, 'title')}>Column layouts</Heading1>
      <Heading2 {...keyed({}, 'columns-heading')}>Three columns</Heading2>
      <ColumnList {...keyed({}, 'columns')}>
        <Column {...keyed({}, 'left')}>
          <Heading3 {...keyed({}, 'left-heading')}>Left</Heading3>
          <Paragraph {...keyed({}, 'left-body')}>Supporting context and notes.</Paragraph>
        </Column>
        <Column {...keyed({}, 'middle')}>
          <Heading3 {...keyed({}, 'middle-heading')}>Middle</Heading3>
          <Paragraph {...keyed({}, 'middle-body')}>
            Primary content in a plain column layout.
          </Paragraph>
        </Column>
        <Column {...keyed({}, 'right')}>
          <Heading3 {...keyed({}, 'right-heading')}>Right</Heading3>
          <Paragraph {...keyed({}, 'right-body')}>
            Secondary metadata and follow-up actions.
          </Paragraph>
        </Column>
      </ColumnList>
      <Callout {...keyed({ icon: 'ℹ️', color: 'gray_background' }, 'callout')}>
        Plain column layouts are live sync-safe. Width ratios stay documented separately until the
        public API accepts them.
      </Callout>
    </Page>
  )
}

const childDbAndPagePage = (ui: DemoUi, ctx = emptyDemoContext): ReactElement => {
  const { Page, Heading1, Heading2, Paragraph, LinkToPage, Callout, InlineCode } = ui

  return (
    <Page>
      <Heading1 {...keyed({}, 'title')}>Child DB & page</Heading1>
      <Paragraph {...keyed({}, 'summary')}>
        The Storybook story combines child pages, link-to-page rows, and a host-owned child database
        payload. The public demo keeps the live-safe piece and documents the host-owned part.
      </Paragraph>
      <Heading2 {...keyed({}, 'links-heading')}>link_to_page</Heading2>
      <LinkToPage pageId={pageIdFor(ctx, 'pages-launch-overview')} />
      <LinkToPage pageId={pageIdFor(ctx, 'pages-team-update')} />
      <Heading2 {...keyed({}, 'host-heading')}>Embedded database view</Heading2>
      <Callout {...keyed({ icon: '🚧', color: 'yellow_background' }, 'callout')}>
        <InlineCode>child_database</InlineCode> remains a host-owned payload. Public demo coverage
        stays at the documentation layer until the collection renderer lands.
      </Callout>
    </Page>
  )
}

const modernColorPalettePage = (ui: DemoUi): ReactElement => {
  const { Page, Heading1, Paragraph, Callout, InlineCode } = ui

  return (
    <Page>
      <Heading1 {...keyed({}, 'title')}>Modern color palette</Heading1>
      <Paragraph {...keyed({}, 'summary')}>
        Storybook&apos;s modern color palette story demonstrates the full callout palette against
        the current web skin. The public demo keeps that same palette in a simple, sync-safe page.
      </Paragraph>
      {colors.map((color, index) => (
        <Callout key={color} {...keyed({ icon: '🎨', color }, `callout-${index}`)}>
          Callout color <InlineCode>{color}</InlineCode>
        </Callout>
      ))}
    </Page>
  )
}

export const storybookSyncPages: readonly StorybookSyncPage[] = [
  {
    slug: 'category-blocks',
    title: 'Blocks',
    render: blocksCategoryPage,
  },
  {
    slug: 'category-inline',
    title: 'Inline',
    render: inlineCategoryPage,
  },
  {
    slug: 'category-media-layout',
    title: 'Media & Layout',
    aliases: ['Media and Layout'],
    render: mediaLayoutCategoryPage,
  },
  {
    slug: 'category-pages',
    title: 'Pages',
  },
  {
    slug: 'category-demo',
    title: 'Demo',
  },
  {
    slug: 'pages-launch-overview',
    title: 'LaunchOverview',
    parentSlug: 'category-pages',
    aliases: ['Launch Overview'],
    render: launchOverviewDemo.render,
  },
  {
    slug: 'pages-team-update',
    title: 'TeamUpdate',
    parentSlug: 'category-pages',
    aliases: ['Team Update'],
    render: teamUpdateDemo.render,
  },
  {
    slug: 'pages-tradeoffs-section',
    title: 'TradeoffsSection',
    parentSlug: 'category-pages',
    aliases: ['Tradeoffs Section'],
    render: tradeoffsSectionDemo.render,
  },
  {
    slug: 'demo-00-features-index',
    title: '00 — Features Index',
    parentSlug: 'category-demo',
    aliases: ['Features Index'],
    render: featuresIndexDemo.render,
  },
  {
    slug: 'demo-01-basic-blocks',
    title: '01 — Basic Blocks',
    parentSlug: 'category-demo',
    aliases: ['Basic Blocks'],
    render: basicBlocksDemo.render,
  },
  {
    slug: 'demo-06-bookmarks',
    title: '06 — Bookmarks',
    parentSlug: 'category-demo',
    render: bookmarksPage,
  },
  {
    slug: 'demo-04-code-blocks',
    title: '04 — Code Blocks',
    parentSlug: 'category-demo',
    aliases: ['Code Blocks'],
    render: codeBlocksDemo.render,
  },
  {
    slug: 'demo-03-color-rainbow',
    title: '03 — Color Rainbow',
    parentSlug: 'category-demo',
    aliases: ['Colors and Inline'],
    render: colorRainbowPage,
  },
  {
    slug: 'demo-09-column-layouts',
    title: '09 — Column Layouts',
    parentSlug: 'category-demo',
    render: columnLayoutsPage,
  },
  {
    slug: 'demo-07-links',
    title: '07 — Links',
    parentSlug: 'category-demo',
    aliases: ['Links and Navigation'],
    render: linksAndNavigationDemo.render,
  },
  {
    slug: 'demo-02-lists',
    title: '02 — Lists',
    parentSlug: 'category-demo',
    aliases: ['Lists and To-dos'],
    render: listsAndTodosDemo.render,
  },
  {
    slug: 'demo-08-math-equations',
    title: '08 — Math & Equations',
    parentSlug: 'category-demo',
    aliases: ['Math and Equations'],
    render: mathAndEquationsDemo.render,
  },
  {
    slug: 'demo-17-modern-breadcrumb',
    title: '17 — Modern · Breadcrumb',
    parentSlug: 'category-demo',
    render: placeholderPage(
      'Modern · Breadcrumb',
      'Breadcrumb blocks are owned by the Notion host app. Storybook keeps a local preview, while the public demo documents the gap instead of publishing a brittle fake payload.',
      '#77',
    ),
  },
  {
    slug: 'demo-18-modern-child-db-page',
    title: '18 — Modern · Child DB & Page',
    parentSlug: 'category-demo',
    render: childDbAndPagePage,
  },
  {
    slug: 'demo-19-modern-color-palette',
    title: '19 — Modern · Color Palette',
    parentSlug: 'category-demo',
    render: modernColorPalettePage,
  },
  {
    slug: 'demo-12-modern-column-widths',
    title: '12 — Modern · Column Widths',
    parentSlug: 'category-demo',
    render: placeholderPage(
      'Modern · Column Widths',
      'The prop and web surface support width ratios today, but live append against the public Notion API still rejects column width metadata.',
      '#604',
    ),
  },
  {
    slug: 'demo-15-modern-file-upload',
    title: '15 — Modern · File Upload',
    parentSlug: 'category-demo',
    render: placeholderPage(
      'Modern · File Upload',
      'Upload-backed files, PDFs, audio, and video need the file_upload pipeline before they belong in the rerunnable public demo.',
      '#604',
    ),
  },
  {
    slug: 'demo-16-modern-link-preview',
    title: '16 — Modern · Link Preview',
    parentSlug: 'category-demo',
    render: placeholderPage(
      'Modern · Link Preview',
      'Rich authenticated link previews remain a host-owned payload. The public demo keeps this as documented placeholder coverage.',
      '#77',
    ),
  },
  {
    slug: 'demo-14-modern-meeting-notes',
    title: '14 — Modern · Meeting Notes',
    parentSlug: 'category-demo',
    render: placeholderPage(
      'Modern · Meeting Notes',
      'Meeting notes are a server-driven, read-only block family. The public demo documents the surface without pretending the renderer owns write semantics.',
      '#77',
    ),
  },
  {
    slug: 'demo-13-modern-synced-blocks',
    title: '13 — Modern · Synced Blocks',
    parentSlug: 'category-demo',
    render: placeholderPage(
      'Modern · Synced Blocks',
      'Synced blocks share server-owned content across pages. Storybook can preview the shape, but the public demo treats it as placeholder coverage for now.',
      '#77',
    ),
  },
  {
    slug: 'demo-11-modern-tabs',
    title: '11 — Modern · Tabs',
    parentSlug: 'category-demo',
    render: placeholderPage(
      'Modern · Tabs',
      'Notion tabs are a modern host-owned block family. The public demo keeps them documented as placeholder coverage instead of publishing a fake local payload.',
      '#77',
    ),
  },
  {
    slug: 'demo-10-placeholders',
    title: '10 — Placeholders (v0.2)',
    parentSlug: 'category-demo',
    aliases: ['Coverage Gaps and Host-owned Blocks'],
    render: placeholderPage(
      'Placeholders (v0.2)',
      'This page documents the stories that remain intentionally outside the sync-safe public surface: upload-backed media, host-owned modern blocks, and other server-driven payloads.',
      '#604',
    ),
  },
  {
    slug: 'demo-05-table-of-contents',
    title: '05 — Table of Contents',
    parentSlug: 'category-demo',
    render: tableOfContentsPage,
  },
] as const

export const storybookRootPages = storybookSyncPages.filter(
  (entry) => entry.parentSlug === undefined,
)

export const storybookChildPagesByParent = new Map<string, readonly StorybookSyncPage[]>(
  storybookRootPages
    .map((entry) => entry.slug)
    .map(
      (slug) => [slug, storybookSyncPages.filter((entry) => entry.parentSlug === slug)] as const,
    ),
)
