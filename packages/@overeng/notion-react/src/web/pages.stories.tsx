import type { Meta, StoryObj } from '@storybook/react'

import {
  Bookmark,
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

const meta = {
  title: 'Pages',
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
} satisfies Meta
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
      <Toggle title="Phase 1 — Manufacturing (April)" defaultOpen>
        <Paragraph>
          First production run of <InlineCode>5,000</InlineCode> units. QA pass-rate target 98%.
        </Paragraph>
        <BulletedListItem>
          Factory sign-off memo <Link href="https://example.com/memo">linked here</Link>
        </BulletedListItem>
        <BulletedListItem>Firmware v1.0.3 locked</BulletedListItem>
      </Toggle>
      <Toggle title="Phase 2 — Marketing (May)" defaultOpen>
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
 * The web mirror renders the cover as a banner above the page and the icon
 * above the first block (matching Notion's own web UI layout).
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

/**
 * Icon variants (#618 phase 4c): external image icon, custom_emoji fallback,
 * and a page with no icon/cover. Covers the full {@link PageIcon} union for
 * the web mirror.
 */
export const IconVariants: Story = {
  render: () => (
    <>
      <Page
        title="External icon"
        icon={{
          type: 'external',
          external: {
            url: 'https://www.notion.so/icons/rocket_gray.svg',
          },
        }}
      >
        <Heading2>External icon</Heading2>
        <Paragraph>
          An <Bold>external</Bold> icon envelope points at a public URL and renders as an{' '}
          <InlineCode>&lt;img&gt;</InlineCode>.
        </Paragraph>
      </Page>
      <Page
        title="Custom emoji icon"
        icon={{ type: 'custom_emoji', custom_emoji: { id: 'ce_42' } }}
      >
        <Heading2>Custom emoji icon</Heading2>
        <Paragraph>
          The web mirror has no workspace-emoji registry, so custom_emoji icons render a neutral
          fallback glyph with the source id in the <InlineCode>title</InlineCode> attribute.
        </Paragraph>
      </Page>
      <Page title="No icon, no cover">
        <Heading2>Absent metadata</Heading2>
        <Paragraph>
          Without an icon or cover the page header slot collapses entirely — no banner, no hero
          icon, just the content.
        </Paragraph>
      </Page>
    </>
  ),
}

/**
 * Cover variants (#618 phase 4c): external image cover and file_upload
 * placeholder. The web mirror cannot resolve upload ids to URLs, so file_upload
 * renders a subtle gradient stub.
 */
export const CoverVariants: Story = {
  render: () => (
    <>
      <Page
        title="External cover"
        icon={{ type: 'emoji', emoji: '🌄' }}
        cover={{
          type: 'external',
          external: {
            url: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=1200&q=80',
          },
        }}
      >
        <Heading2>External cover</Heading2>
        <Paragraph>A public URL cover renders directly as the page banner.</Paragraph>
      </Page>
      <Page
        title="File upload cover (placeholder)"
        icon={{ type: 'emoji', emoji: '📎' }}
        cover={{ type: 'file_upload', file_upload: { id: 'up_abc123' } }}
      >
        <Heading2>File upload cover</Heading2>
        <Paragraph>
          <InlineCode>file_upload</InlineCode> covers reference a Notion Files-API asset by id. The
          client cannot resolve these without an API round-trip, so we render a gradient stub —
          hosts that need a real image should pre-resolve before passing the prop.
        </Paragraph>
      </Page>
    </>
  ),
}

/**
 * Child-page icon swap (#618 phase 4c): `<ChildPage icon={...}>` projects the
 * icon inline on the link chip. Falls back to `📄` when icon is absent.
 */
export const ChildPageIcons: Story = {
  render: () => (
    <Page title="Sub-page gallery" icon={{ type: 'emoji', emoji: '🗂️' }}>
      <Heading1>Sub-page gallery</Heading1>
      <Paragraph>Each child below illustrates a different icon envelope.</Paragraph>
      <ChildPage blockKey="emoji" title="Emoji icon" icon={{ type: 'emoji', emoji: '🎨' }} />
      <ChildPage
        blockKey="external"
        title="External icon"
        icon={{
          type: 'external',
          external: { url: 'https://www.notion.so/icons/book_gray.svg' },
        }}
      />
      <ChildPage
        blockKey="custom"
        title="Custom emoji icon (fallback)"
        icon={{ type: 'custom_emoji', custom_emoji: { id: 'ce_7' } }}
      />
      <ChildPage blockKey="absent" title="No icon — falls back to 📄" />
    </Page>
  ),
}

/**
 * Canonical page (#618 phase 5a): one of every major block type composed into
 * a plausible page. Useful as a visual regression surface and a "what does the
 * full web mirror look like?" reference.
 */
export const CanonicalPage: Story = {
  render: () => (
    <Page
      title="Nimbus — product brief"
      icon={{ type: 'emoji', emoji: '🛸' }}
      cover={{
        type: 'external',
        external: {
          url: 'https://images.unsplash.com/photo-1464802686167-b939a6910659?w=1200&q=80',
        },
      }}
    >
      <Heading1>Nimbus — product brief</Heading1>
      <TableOfContents />
      <Callout icon="🎯" color="blue_background">
        <Bold>Goal:</Bold> ship Nimbus <Italic>v1</Italic> with three SKUs in{' '}
        <InlineCode>US</InlineCode> and <InlineCode>EU</InlineCode>.
      </Callout>
      <Paragraph>
        This page exercises one of every block we render. Edit it as the renderer evolves so the
        canonical surface stays current.
      </Paragraph>
      <Heading2>Pricing</Heading2>
      <Table tableWidth={3} hasColumnHeader>
        <TableRow cells={['Tier', 'Price', 'Highlight']} />
        <TableRow cells={['Nimbus One', '$89', 'Core dimming']} />
        <TableRow cells={['Nimbus Plus', '$129', 'Color temperature']} />
        <TableRow cells={['Nimbus Pro', '$179', 'Full RGB + scenes']} />
      </Table>
      <Heading2>Plan</Heading2>
      <ToDo checked>Lock SKU matrix</ToDo>
      <ToDo checked>Firmware v1.0.3 signed</ToDo>
      <ToDo>Confirm packaging backup supplier</ToDo>
      <BulletedListItem>Factory QA above 98%</BulletedListItem>
      <BulletedListItem>Press kit legal-approved</BulletedListItem>
      <NumberedListItem>Freeze firmware</NumberedListItem>
      <NumberedListItem>Ship to press</NumberedListItem>
      <NumberedListItem>Open public order form</NumberedListItem>
      <Heading3>Open questions</Heading3>
      <Toggle title="Should we add a warranty extension SKU? (click to expand)">
        <Paragraph>
          Deferred to v1.1. Current SKUs already span the pricing envelope we validated in research.
        </Paragraph>
      </Toggle>
      <Heading3>Snippet</Heading3>
      <Code language="ts">{`export const tiers = ['one', 'plus', 'pro'] as const`}</Code>
      <Quote>
        The best launches are <Italic>boring</Italic> launches.
      </Quote>
      <Divider />
      <Heading2>Layout</Heading2>
      <ColumnList>
        <Column>
          <Heading3>US</Heading3>
          <Paragraph>
            Launch <InlineCode>June 3</InlineCode>.
          </Paragraph>
        </Column>
        <Column>
          <Heading3>EU</Heading3>
          <Paragraph>
            Launch <InlineCode>June 17</InlineCode>.
          </Paragraph>
        </Column>
      </ColumnList>
      <Heading2>References</Heading2>
      <Bookmark url="https://notion.so" />
      <Image
        url="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=80"
        caption="Nimbus Smart Lamp — studio reference"
      />
      <Heading2>Sub-pages</Heading2>
      <ChildPage blockKey="spec" title="Technical spec" icon={{ type: 'emoji', emoji: '📐' }}>
        <Paragraph>
          Full hardware + firmware spec. See <Link href="#">the linked doc</Link>.
        </Paragraph>
        <BulletedListItem>ARM Cortex-M4 @ 120 MHz</BulletedListItem>
        <BulletedListItem>Wi-Fi 802.11 b/g/n + BLE 5.0</BulletedListItem>
      </ChildPage>
      <ChildPage
        blockKey="launch-runbook"
        title="Launch runbook"
        icon={{ type: 'emoji', emoji: '🚀' }}
      />
      <Paragraph>
        Last updated <Mention mention={{ user: { id: 'u1' } }} plainText="@priya" /> · April 19,
        2026.
      </Paragraph>
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

/**
 * Empty page — `<Page title="Empty" />` with no children. Documents the
 * current behaviour: the page-scope wrapper renders with title/icon slots
 * collapsed (no icon/cover supplied) and an empty content flex-column.
 * Useful as a baseline to reason about sub-page placeholders.
 */
export const EmptyPage: Story = {
  render: () => <Page title="Empty" />,
}

/**
 * `<ChildPage>` with no content beyond its title — the inline link chip. Used
 * as a leaf sub-page marker in parent pages that don't hydrate the full
 * sub-page body.
 */
export const EmptyChildPage: Story = {
  render: () => (
    <Page title="Sub-pages only">
      <ChildPage blockKey="empty-sub" title="No body" />
    </Page>
  ),
}
