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
      <ToDo checked>Write the component library</ToDo>
      <ToDo checked>Extract shared prop types</ToDo>
      <ToDo>Ship Storybook preview</ToDo>
      <ToDo>Document the public API</ToDo>
    </Page>
  ),
}

export const ToggleBlock: Story = {
  render: () => (
    <Page>
      <Toggle title="Why a custom renderer?">
        <Paragraph>
          react-notion-x requires synthesising an internal RecordMap. A custom DOM renderer lets us
          reuse the same JSX we send to the reconciler with no translation step.
        </Paragraph>
      </Toggle>
      <Toggle title="What's in v0.1?">
        <Paragraph>Minimal visual defaults — not the full Notion design system.</Paragraph>
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
      <Callout icon="💡">Tip: wrap every page in a `Page` so the notion-page scope applies.</Callout>
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
