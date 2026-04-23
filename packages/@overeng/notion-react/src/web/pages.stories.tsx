import type { Meta, StoryObj } from '@storybook/react'

import {
  BulletedListItem,
  Callout,
  ChildPage,
  Code,
  Column,
  ColumnList,
  Divider,
  Heading1,
  Heading2,
  Heading3,
  Image,
  NumberedListItem,
  Page,
  Paragraph,
  Quote,
  Table,
  TableOfContents,
  TableRow,
  ToDo,
  Toggle,
} from './blocks.tsx'
import { Bold, InlineCode, Italic, Link, Mention } from './inline.tsx'

const meta = { title: 'Pages', parameters: { layout: 'fullscreen' } } satisfies Meta
export default meta

type Story = StoryObj

export const LaunchOverview: Story = {
  render: () => (
    <Page>
      <Heading1>Q2 Launch · Nimbus Smart Lamp</Heading1>
      <Callout icon="🎯" color="gray_background">
        <Bold>Ship date:</Bold> June 3 · <Bold>Units:</Bold> 10,000 · <Bold>Markets:</Bold> US, EU
      </Callout>
      <Heading2>Pricing tiers</Heading2>
      <Table tableWidth={3} hasColumnHeader>
        <TableRow cells={['Tier', 'Price', 'Highlight']} />
        <TableRow cells={['Nimbus One', '$89', 'Core dimming + app control']} />
        <TableRow cells={['Nimbus Plus', '$129', 'Adds color temperature']} />
        <TableRow cells={['Nimbus Pro', '$179', 'Full RGB + scenes']} />
      </Table>
      <Heading2>Phases</Heading2>
      <Toggle title="Phase 1 — Manufacturing (April)">
        <Paragraph>
          First production run of <InlineCode>5,000</InlineCode> units. QA pass-rate target 98%.
        </Paragraph>
        <BulletedListItem>
          Factory sign-off memo <Link href="https://example.com/memo">linked here</Link>
        </BulletedListItem>
        <BulletedListItem>Firmware v1.0.3 locked</BulletedListItem>
      </Toggle>
      <Toggle title="Phase 2 — Marketing (May)">
        <Paragraph>Press kit, launch video, influencer seeding.</Paragraph>
      </Toggle>
      <Heading2>Timeline</Heading2>
      <Paragraph>
        April 10 · <Italic>planning</Italic> — finalized SKU matrix.
      </Paragraph>
      <Paragraph>
        April 19 · <Italic>review</Italic> — sign-off from{' '}
        <Mention mention={{ user: { id: 'u1' } }} plainText="@priya" />.
      </Paragraph>
      <Paragraph>
        May 02 · <Italic>marketing</Italic> — embargo lifts, press briefings begin.
      </Paragraph>
    </Page>
  ),
}

export const TeamUpdate: Story = {
  render: () => (
    <Page>
      <Heading1>Launch Update · Friday, April 19 2026</Heading1>
      <Paragraph>
        Manufacturing is <Bold>on track</Bold>. First 500 units cleared QA this morning with a 99%
        pass rate — above target. Marketing kicks off next week.
      </Paragraph>
      <Heading3>Wins</Heading3>
      <BulletedListItem>QA pass rate above target (99% vs 98%)</BulletedListItem>
      <BulletedListItem>Press kit approved by legal on the first pass</BulletedListItem>
      <Heading3>Risks</Heading3>
      <BulletedListItem>
        Packaging supplier is quoting two extra weeks — contingency plan in progress.
      </BulletedListItem>
      <Heading3>Quote of the week</Heading3>
      <Quote>
        The best launches are <Italic>boring</Italic> launches.
      </Quote>
      <Divider />
      <Heading3>Next</Heading3>
      <ToDo>Confirm packaging backup supplier by Wednesday</ToDo>
      <ToDo>Share press kit with wave-1 publications</ToDo>
      <ToDo>Lock final pricing for Nimbus Plus</ToDo>
    </Page>
  ),
}

/**
 * Exercises root `<Page>` metadata props (#618): `title`, `icon`, `cover`.
 * The web mirror's `Page` wrapper does not render these today, so this story
 * primarily documents the JSX-driven surface — the Notion-host equivalent
 * drives `pages.update` on the sync root from the same prop shape.
 */
export const RootMetadata: Story = {
  render: () => (
    <Page
      title="Q2 Launch Plan"
      icon={{ type: 'emoji', emoji: '🚀' }}
      cover={{
        type: 'external',
        external: {
          url: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=1200&q=80',
        },
      }}
    >
      <Heading1>Q2 Launch Plan</Heading1>
      <Callout icon="📅" color="blue_background">
        <Bold>Window:</Bold> April 1 — June 30 · <Bold>Owner:</Bold> Priya
      </Callout>
      <Heading2>Goals</Heading2>
      <BulletedListItem>Ship three SKUs in two markets</BulletedListItem>
      <BulletedListItem>Hit 98% QA pass rate across the first production run</BulletedListItem>
      <BulletedListItem>Keep NPS at launch above 55</BulletedListItem>
    </Page>
  ),
}

/**
 * Nested structure (#618): root `<Page>` → `<ChildPage>` (with its own
 * title/icon) → nested content. Demonstrates the JSX-driven sub-page surface
 * — each `<ChildPage>` is its own sync boundary with its own `blockKey`
 * namespace, and `diff()` descends recursively through retained sub-pages.
 */
export const NestedSubPages: Story = {
  render: () => (
    <Page title="Team handbook" icon={{ type: 'emoji', emoji: '📘' }}>
      <Heading1>Team handbook</Heading1>
      <Paragraph>
        Living reference for how we work. Each section below is its own sub-page — open one to see
        its contents.
      </Paragraph>
      <ChildPage blockKey="onboarding" title="Onboarding" icon={{ type: 'emoji', emoji: '👋' }}>
        <Heading2>Week 1</Heading2>
        <Paragraph>
          Pair with your buddy, get accounts set up, ship a tiny PR on day three.
        </Paragraph>
        <Toggle title="Accounts checklist">
          <BulletedListItem>GitHub invite accepted</BulletedListItem>
          <BulletedListItem>1Password vault joined</BulletedListItem>
          <BulletedListItem>Notion workspace access</BulletedListItem>
          <BulletedListItem>Slack channels auto-joined</BulletedListItem>
        </Toggle>
        <Heading3>Your buddy</Heading3>
        <Paragraph>
          Your buddy is your go-to for the first two weeks. Ping them for anything — no question is
          too small.
        </Paragraph>
      </ChildPage>
      <ChildPage
        blockKey="engineering-guide"
        title="Engineering guide"
        icon={{ type: 'emoji', emoji: '🛠️' }}
      >
        <Heading2>How we ship</Heading2>
        <Paragraph>
          Small PRs, green CI, review within one business day. <InlineCode>main</InlineCode> is
          always deployable.
        </Paragraph>
        <Toggle title="Commit conventions">
          <Paragraph>
            Prefix with the affected package and a short verb: <InlineCode>feat(api): …</InlineCode>
            , <InlineCode>fix(ui): …</InlineCode>, <InlineCode>chore(deps): …</InlineCode>.
          </Paragraph>
        </Toggle>
        <ChildPage
          blockKey="review-etiquette"
          title="Review etiquette"
          icon={{ type: 'emoji', emoji: '🧐' }}
        >
          <Heading2>Review etiquette</Heading2>
          <Paragraph>Lead with questions, not opinions. Assume good faith.</Paragraph>
          <NumberedListItem>Read the whole diff before commenting</NumberedListItem>
          <NumberedListItem>Prefer suggestions over imperatives</NumberedListItem>
          <NumberedListItem>Explicitly approve — "LGTM" counts</NumberedListItem>
        </ChildPage>
      </ChildPage>
      <ChildPage blockKey="ops-runbook" title="Ops runbook" icon={{ type: 'emoji', emoji: '🚨' }}>
        <Heading2>On-call</Heading2>
        <Paragraph>Rotation is weekly, Mondays 10:00 CET handoff.</Paragraph>
      </ChildPage>
    </Page>
  ),
}

export const TradeoffsSection: Story = {
  render: () => (
    <Page>
      <Heading1>Tradeoffs</Heading1>
      <TableOfContents />
      <Heading2>T-001 · Launch with three tiers instead of two</Heading2>
      <Paragraph>
        <Bold>Status:</Bold> accepted · <Bold>Date:</Bold> 2026-04-12
      </Paragraph>
      <Heading3>Context</Heading3>
      <Paragraph>
        Market research showed two distinct price-sensitive segments. A single mid-tier SKU would
        have left both margin on the table and low-end volume uncaptured.
      </Paragraph>
      <Heading3>Decision</Heading3>
      <Callout icon="✅" color="green_background">
        Ship <InlineCode>One</InlineCode>, <InlineCode>Plus</InlineCode>, and{' '}
        <InlineCode>Pro</InlineCode> tiers at $89 / $129 / $179.
      </Callout>
      <Heading3>Consequences</Heading3>
      <NumberedListItem>Three SKUs to manage in inventory and marketing</NumberedListItem>
      <NumberedListItem>Clearer upsell path from One → Plus → Pro</NumberedListItem>
      <NumberedListItem>Packaging cost up 4% due to per-SKU artwork</NumberedListItem>
      <Heading3>Pricing snippet</Heading3>
      <Code language="ts">{`const pricing = {
  one: 89,
  plus: 129,
  pro: 179,
} as const`}</Code>
      <Divider />
      <Heading2>T-002 · Delay EU launch by two weeks</Heading2>
      <Paragraph>
        Regulatory review on the wireless module came back with minor labelling asks. Safer to batch
        the fix than ship twice.
      </Paragraph>
      <ColumnList>
        <Column>
          <Heading3>Before</Heading3>
          <Paragraph>Simultaneous US + EU launch on June 3.</Paragraph>
        </Column>
        <Column>
          <Heading3>After</Heading3>
          <Paragraph>
            US on <InlineCode>June 3</InlineCode>, EU on <InlineCode>June 17</InlineCode>.
          </Paragraph>
        </Column>
      </ColumnList>
      <Heading3>Product shot</Heading3>
      <Image
        url="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=80"
        caption="Nimbus Smart Lamp — studio reference"
      />
    </Page>
  ),
}
