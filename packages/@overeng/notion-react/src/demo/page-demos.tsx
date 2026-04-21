import type { ReactElement, ReactNode } from 'react'

import type {
  BulletedListItemProps,
  CalloutProps,
  CodeProps,
  ColumnListProps,
  ColumnProps,
  HeadingProps,
  InlineAnnotationProps,
  LinkProps,
  MediaProps,
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
  readonly TableOfContents: BlockEl<TableOfContentsProps>
  readonly Bold: InlineEl<InlineAnnotationProps>
  readonly Italic: InlineEl<InlineAnnotationProps>
  readonly InlineCode: InlineEl<InlineAnnotationProps>
  readonly Link: InlineEl<LinkProps>
}

type DemoEntry = {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly storyTitle: string
  readonly render: (ui: DemoUi) => ReactElement
}

const keyed = <T extends object>(props: T, blockKey: string): T & { readonly blockKey: string } => ({
  ...props,
  blockKey,
})

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
          <Bold>Ship date:</Bold> June 3 · <Bold>Units:</Bold> 10,000 · <Bold>Markets:</Bold> US,
          EU
        </Callout>
        <Heading2 {...keyed({}, 'pricing-heading')}>Pricing tiers</Heading2>
        <Table
          {...keyed({ tableWidth: 3, hasColumnHeader: true }, 'pricing-tiers')}
        >
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
          <BulletedListItem {...keyed({}, 'phase-1-fw')}>
            Firmware v1.0.3 locked
          </BulletedListItem>
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
          Manufacturing is <Bold>on track</Bold>. First 500 units cleared QA this morning with a
          99% pass rate — above target. Marketing kicks off next week.
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
        <Heading2 {...keyed({}, 't001-title')}>T-001 · Launch with three tiers instead of two</Heading2>
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

export const notionPageDemos = [launchOverviewDemo, teamUpdateDemo, tradeoffsSectionDemo] as const

export const renderDemoBySlug = (slug: string, ui: DemoUi): ReactElement => {
  const demo = notionPageDemos.find((entry) => entry.slug === slug)
  if (demo === undefined) {
    throw new Error(`Unknown notion demo slug: ${slug}`)
  }
  return demo.render(ui)
}

export const buildDemoLandingSummary = (entries: readonly DemoEntry[]): ReactNode =>
  entries.map((entry) => entry.title).join(', ')
