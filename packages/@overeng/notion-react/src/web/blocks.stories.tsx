import type { Meta, StoryObj } from '@storybook/react'

import {
  BulletedListItem,
  Callout,
  Code,
  Divider,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  NumberedListItem,
  Page,
  Paragraph,
  Quote,
  ToDo,
  Toggle,
} from './blocks.tsx'
import { Bold, InlineCode, Italic } from './inline.tsx'

const meta = { title: 'Blocks' } satisfies Meta
export default meta

type Story = StoryObj

export const Headings: Story = {
  render: () => (
    <Page>
      <Heading1>Heading 1 — a page title</Heading1>
      <Heading2>Heading 2 — a section</Heading2>
      <Heading3>Heading 3 — a subsection</Heading3>
      <Heading4>Heading 4 — an aside</Heading4>
      <Heading2 toggleable>Toggleable heading (click the ▸)</Heading2>
      <Heading2 color="blue">Colored heading — blue</Heading2>
      <Heading3 color="red_background">Colored heading — red background</Heading3>
    </Page>
  ),
}

export const Paragraphs: Story = {
  render: () => (
    <Page>
      <Paragraph>
        Plain paragraph text. Supports <Bold>bold</Bold>, <Italic>italic</Italic>, and{' '}
        <InlineCode>inline code</InlineCode>.
      </Paragraph>
      <Paragraph>
        Paragraphs adjacent to each other keep a consistent vertical rhythm matching the Notion
        baseline.
      </Paragraph>
    </Page>
  ),
}

export const BulletedList: Story = {
  render: () => (
    <Page>
      <BulletedListItem>First bullet</BulletedListItem>
      <BulletedListItem>Second bullet</BulletedListItem>
      <BulletedListItem>
        Third bullet with <Bold>bold</Bold> text
      </BulletedListItem>
    </Page>
  ),
}

export const NumberedList: Story = {
  render: () => (
    <Page>
      <NumberedListItem>Step one</NumberedListItem>
      <NumberedListItem>Step two</NumberedListItem>
      <NumberedListItem>Step three</NumberedListItem>
    </Page>
  ),
}

export const ToDoList: Story = {
  render: () => (
    <Page>
      <ToDo checked>Finalize SKU matrix</ToDo>
      <ToDo checked>Lock firmware v1.0.3</ToDo>
      <ToDo>Confirm packaging backup supplier</ToDo>
      <ToDo>Share press kit with wave-1 publications</ToDo>
    </Page>
  ),
}

export const ToggleBlock: Story = {
  render: () => (
    <Page>
      <Toggle title="Phase 1 — Manufacturing">
        <Paragraph>
          First production run of 5,000 units. QA pass-rate target 98%, packaging audit week of
          April 22.
        </Paragraph>
      </Toggle>
      <Toggle title="Phase 2 — Marketing">
        <Paragraph>Press kit, launch video, influencer seeding through May.</Paragraph>
      </Toggle>
    </Page>
  ),
}

export const CodeBlock: Story = {
  render: () => (
    <Page>
      <Code language="tsx">{`import { Heading1, Page, Paragraph } from '@overeng/notion-react/web'
import '@overeng/notion-react/web/styles.css'

export const Example = () => (
  <Page>
    <Heading1>Hello</Heading1>
    <Paragraph>Rendered as DOM.</Paragraph>
  </Page>
)`}</Code>
      <Code language="bash">{`pnpm --filter @overeng/notion-react storybook`}</Code>
    </Page>
  ),
}

export const QuoteBlock: Story = {
  render: () => (
    <Page>
      <Quote>
        Simplicity is the ultimate sophistication. — <Italic>Leonardo da Vinci</Italic>
      </Quote>
    </Page>
  ),
}

export const CalloutBlock: Story = {
  render: () => (
    <Page>
      <Callout icon="💡">
        Tip: wrap every page in a `Page` so the notion-page scope applies.
      </Callout>
      <Callout icon="✅" color="green_background">
        Success: the web renderer shares prop types with the Notion host.
      </Callout>
      <Callout icon="⚠️" color="yellow_background">
        Warning: v0.1 does not support nested children inside callouts yet.
      </Callout>
      <Callout icon="🚫" color="red_background">
        Error: missing URL on an image renders an empty placeholder.
      </Callout>
    </Page>
  ),
}

export const DividerBlock: Story = {
  render: () => (
    <Page>
      <Paragraph>Above the divider.</Paragraph>
      <Divider />
      <Paragraph>Below the divider.</Paragraph>
    </Page>
  ),
}
