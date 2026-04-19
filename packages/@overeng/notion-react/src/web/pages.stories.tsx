import type { Meta, StoryObj } from '@storybook/react'

import {
  BulletedListItem,
  Callout,
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

export const DailyPage: Story = {
  render: () => (
    <Page>
      <Heading1>Daily · 2026-04-19</Heading1>
      <Callout icon="📊" color="gray_background">
        <Bold>8h 41m</Bold> screen time · <Bold>3h 12m</Bold> coding · focus score{' '}
        <Bold>74</Bold>
      </Callout>
      <Heading2>Top apps</Heading2>
      <Table>
        <TableRow>
          <td>App</td>
          <td>Duration</td>
          <td>Category</td>
        </TableRow>
        <TableRow>
          <td>VSCode</td>
          <td>3h 12m</td>
          <td>coding</td>
        </TableRow>
        <TableRow>
          <td>Chrome</td>
          <td>1h 47m</td>
          <td>browsing</td>
        </TableRow>
        <TableRow>
          <td>Slack</td>
          <td>42m</td>
          <td>comms</td>
        </TableRow>
      </Table>
      <Heading2>Projects</Heading2>
      <Toggle title="pixeltrail">
        <Paragraph>
          Focused on the Notion sync pipeline — fixed a <InlineCode>busy_timeout</InlineCode> race,
          pushed incremental sync behind a flag.
        </Paragraph>
        <BulletedListItem>
          PR <Link href="https://github.com/schickling/dotfiles/pull/663">#663</Link> ready for
          review
        </BulletedListItem>
        <BulletedListItem>Tray adopts orphaned capture on restart</BulletedListItem>
      </Toggle>
      <Toggle title="notion-react">
        <Paragraph>Scaffolded package + reconciler + cache + integration harness.</Paragraph>
      </Toggle>
      <Heading2>Timeline</Heading2>
      <Paragraph>
        09:12 · <Italic>planning</Italic> — sketched the web renderer approach.
      </Paragraph>
      <Paragraph>
        10:05 · <Italic>coding</Italic> — set up Storybook + composite stories.
      </Paragraph>
      <Paragraph>
        14:22 · <Italic>review</Italic> — addressed PR feedback from{' '}
        <Mention mention={{ user: { id: 'u1' } }} plainText="@reviewer" />.
      </Paragraph>
    </Page>
  ),
}

export const JournalEntry: Story = {
  render: () => (
    <Page>
      <Heading1>Journal · Saturday, April 19 2026</Heading1>
      <Paragraph>
        Mostly a day for <Bold>deep work</Bold>. Shipped the first pass of the Notion web renderer
        — components double as DOM previews now. Felt good to see the same JSX render both ways.
      </Paragraph>
      <Heading3>Wins</Heading3>
      <BulletedListItem>Dual-export prop types stay in sync by construction</BulletedListItem>
      <BulletedListItem>Storybook scaffolded in under an hour using the shared config</BulletedListItem>
      <Heading3>Frustrations</Heading3>
      <BulletedListItem>
        One edit silently reverted on disk — had to re-apply. Worth a follow-up investigation.
      </BulletedListItem>
      <Heading3>Quote of the day</Heading3>
      <Quote>
        The best writing is <Italic>rewriting</Italic>.
      </Quote>
      <Divider />
      <Heading3>Tomorrow</Heading3>
      <ToDo>Push the PR and request review</ToDo>
      <ToDo>Draft a short walkthrough of the renderer API</ToDo>
      <ToDo>Switch gears to the spec polish</ToDo>
    </Page>
  ),
}

export const DecisionsSection: Story = {
  render: () => (
    <Page>
      <Heading1>Decisions</Heading1>
      <TableOfContents />
      <Heading2>D-001 · Use a custom DOM renderer for Storybook</Heading2>
      <Paragraph>
        <Bold>Status:</Bold> accepted · <Bold>Date:</Bold> 2026-04-19
      </Paragraph>
      <Heading3>Context</Heading3>
      <Paragraph>
        We wanted Storybook to preview our Notion block components visually. Three options:
        react-notion-x (requires RecordMap synthesis), a custom DOM renderer (mirror components),
        or a hybrid.
      </Paragraph>
      <Heading3>Decision</Heading3>
      <Callout icon="✅" color="green_background">
        Custom DOM renderer under <InlineCode>src/web/</InlineCode>, shared prop types via{' '}
        <InlineCode>components/props.ts</InlineCode>.
      </Callout>
      <Heading3>Consequences</Heading3>
      <NumberedListItem>No upstream coupling to react-notion-x's internal RecordMap shape</NumberedListItem>
      <NumberedListItem>Prop drift is a compile-time error, not a runtime one</NumberedListItem>
      <NumberedListItem>We own the styling; fidelity grows with the design we need</NumberedListItem>
      <Heading3>Code sketch</Heading3>
      <Code language="tsx">{`import { Heading1, Paragraph, Page } from '@overeng/notion-react/web'
import '@overeng/notion-react/web/styles.css'

<Page>
  <Heading1>Hello</Heading1>
  <Paragraph>Rendered as DOM.</Paragraph>
</Page>`}</Code>
      <Divider />
      <Heading2>D-002 · Shared prop types live in components/props.ts</Heading2>
      <Paragraph>
        Both the Notion-host and web surfaces import from the same module. A drift in one surface
        becomes a type error in the other.
      </Paragraph>
      <ColumnList>
        <Column>
          <Heading3>Before</Heading3>
          <Paragraph>Prop types were inlined per component, duplicated across surfaces.</Paragraph>
        </Column>
        <Column>
          <Heading3>After</Heading3>
          <Paragraph>
            Single <InlineCode>props.ts</InlineCode> source of truth, referenced by both sides.
          </Paragraph>
        </Column>
      </ColumnList>
      <Heading3>Supporting image</Heading3>
      <Image
        url="https://images.unsplash.com/photo-1523961131990-5ea7c61b2107?w=800&q=80"
        caption="two trees, one root (architecture reference)"
      />
    </Page>
  ),
}
