import type { Meta, StoryObj } from '@storybook/react'

import {
  BulletedListItem,
  ChildPage,
  Code,
  Heading1,
  Heading2,
  Heading3,
  NumberedListItem,
  Page,
  Paragraph,
  Toggle,
} from './blocks.tsx'
import { Bold, InlineCode, Italic, Link } from './inline.tsx'

/**
 * Standalone stories for each sub-page referenced by `<ChildPage blockKey=...>`
 * in `pages.stories.tsx`. The preview-scoped URL resolver in
 * `.storybook/preview.tsx` maps blockKey → storyId here, so clicking a
 * ChildPage chip in NestedSubPages / CanonicalPage navigates to the matching
 * story and shows the sub-page's title + body as a real page — mirroring the
 * way Notion navigates into a child page.
 *
 * New blockKeys used in parent stories should get a matching story here and an
 * entry in the preview resolver's registry; otherwise the ChildPage renders as
 * an inert anchor (silent miss, same as a production host that does not
 * resolve a given pageId).
 */
const meta = {
  title: 'Pages/SubPage',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

export const Onboarding: Story = {
  render: () => (
    <Page title="Onboarding" icon={{ type: 'emoji', emoji: '👋' }}>
      <Heading2>Week 1</Heading2>
      <Paragraph>Pair with your buddy, get accounts set up, ship a tiny PR on day three.</Paragraph>
      <Toggle title="Accounts checklist" defaultOpen>
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
    </Page>
  ),
}

export const EngineeringGuide: Story = {
  render: () => (
    <Page title="Engineering guide" icon={{ type: 'emoji', emoji: '🛠️' }}>
      <Heading2>How we ship</Heading2>
      <Paragraph>
        Small PRs, green CI, review within one business day. <InlineCode>main</InlineCode> is always
        deployable.
      </Paragraph>
      <Toggle title="Commit conventions" defaultOpen>
        <Paragraph>
          Prefix with the affected package and a short verb: <InlineCode>feat(api): …</InlineCode>,{' '}
          <InlineCode>fix(ui): …</InlineCode>, <InlineCode>chore(deps): …</InlineCode>.
        </Paragraph>
      </Toggle>
      <Heading2>Sub-pages</Heading2>
      <ChildPage
        blockKey="review-etiquette"
        title="Review etiquette"
        icon={{ type: 'emoji', emoji: '🧐' }}
      />
    </Page>
  ),
}

export const ReviewEtiquette: Story = {
  render: () => (
    <Page title="Review etiquette" icon={{ type: 'emoji', emoji: '🧐' }}>
      <Heading2>Review etiquette</Heading2>
      <Paragraph>Lead with questions, not opinions. Assume good faith.</Paragraph>
      <NumberedListItem>Read the whole diff before commenting</NumberedListItem>
      <NumberedListItem>Prefer suggestions over imperatives</NumberedListItem>
      <NumberedListItem>
        Explicitly approve — <Italic>"LGTM"</Italic> counts
      </NumberedListItem>
    </Page>
  ),
}

export const OpsRunbook: Story = {
  render: () => (
    <Page title="Ops runbook" icon={{ type: 'emoji', emoji: '🚨' }}>
      <Heading2>On-call</Heading2>
      <Paragraph>Rotation is weekly, Mondays 10:00 CET handoff.</Paragraph>
      <Heading3>Escalation</Heading3>
      <NumberedListItem>Check the status dashboard first</NumberedListItem>
      <NumberedListItem>
        Page the secondary if not acknowledged in <InlineCode>5 min</InlineCode>
      </NumberedListItem>
      <NumberedListItem>File an incident doc before mitigating</NumberedListItem>
    </Page>
  ),
}

export const Spec: Story = {
  render: () => (
    <Page title="Technical spec" icon={{ type: 'emoji', emoji: '📐' }}>
      <Heading1>Nimbus — technical spec</Heading1>
      <Paragraph>
        Full hardware + firmware spec. See <Link href="#">the linked doc</Link>.
      </Paragraph>
      <Heading2>Hardware</Heading2>
      <BulletedListItem>ARM Cortex-M4 @ 120 MHz</BulletedListItem>
      <BulletedListItem>Wi-Fi 802.11 b/g/n + BLE 5.0</BulletedListItem>
      <BulletedListItem>16-bit PWM dimming driver</BulletedListItem>
      <Heading2>Firmware</Heading2>
      <Paragraph>
        <Bold>v1.0.3</Bold> locked for launch. OTA update channel staged for week 6 post-launch.
      </Paragraph>
      <Code language="ts">{`const firmware = {
  version: '1.0.3',
  channel: 'stable',
} as const`}</Code>
    </Page>
  ),
}

export const LaunchRunbook: Story = {
  render: () => (
    <Page title="Launch runbook" icon={{ type: 'emoji', emoji: '🚀' }}>
      <Heading2>T-0 day</Heading2>
      <NumberedListItem>09:00 — open the store</NumberedListItem>
      <NumberedListItem>09:15 — post the launch tweet</NumberedListItem>
      <NumberedListItem>10:00 — first metrics checkpoint</NumberedListItem>
      <Heading2>Rollback</Heading2>
      <Paragraph>
        If <InlineCode>error_rate &gt; 2%</InlineCode> sustained over 15 minutes, flip the{' '}
        <InlineCode>launch_enabled</InlineCode> flag off and page the on-call.
      </Paragraph>
    </Page>
  ),
}
