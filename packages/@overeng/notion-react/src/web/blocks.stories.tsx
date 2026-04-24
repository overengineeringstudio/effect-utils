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

const meta = { title: 'Blocks', tags: ['autodocs'] } satisfies Meta
export default meta

type Story = StoryObj

const HEADING_COLORS = [
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
  'red_background',
  'blue_background',
] as const

export const Headings: Story = {
  argTypes: {
    color: { control: 'select', options: HEADING_COLORS },
    toggleable: { control: 'boolean' },
  },
  args: { color: 'blue', toggleable: false },
  render: (args: Record<string, unknown>) => (
    <Page>
      <Heading1>Heading 1 — a page title</Heading1>
      <Heading2>Heading 2 — a section</Heading2>
      <Heading3>Heading 3 — a subsection</Heading3>
      <Heading4>Heading 4 — an aside</Heading4>
      <Heading2 toggleable={args.toggleable as boolean}>
        Toggleable-controlled heading (click the ▸)
      </Heading2>
      {args.color === 'default' ? (
        <Heading2>Colored heading (knob-controlled: default)</Heading2>
      ) : (
        <Heading2 color={args.color as Exclude<(typeof HEADING_COLORS)[number], 'default'>}>
          Colored heading (knob-controlled)
        </Heading2>
      )}
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
  argTypes: {
    checked: { control: 'boolean' },
  },
  args: { checked: false },
  render: (args: Record<string, unknown>) => (
    <Page>
      <ToDo checked>Finalize SKU matrix</ToDo>
      <ToDo checked>Lock firmware v1.0.3</ToDo>
      <ToDo checked={args.checked as boolean}>Confirm packaging backup supplier</ToDo>
      <ToDo>Share press kit with wave-1 publications</ToDo>
    </Page>
  ),
}

export const ToggleBlock: Story = {
  argTypes: {
    defaultOpen: { control: 'boolean' },
    title: { control: 'text' },
  },
  args: { defaultOpen: false, title: 'Phase 1 — Manufacturing' },
  render: (args: Record<string, unknown>) => (
    <Page>
      <Toggle title={args.title as string} defaultOpen={args.defaultOpen as boolean}>
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
  argTypes: {
    language: {
      control: 'select',
      options: ['tsx', 'ts', 'js', 'jsx', 'bash', 'json', 'md', 'py', 'rs', 'go'],
    },
  },
  args: { language: 'tsx' },
  render: (args: Record<string, unknown>) => (
    <Page>
      <Code
        language={args.language as string}
      >{`import { Heading1, Page, Paragraph } from '@overeng/notion-react/web'
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

const CALLOUT_COLORS = [
  'default',
  'gray_background',
  'brown_background',
  'orange_background',
  'yellow_background',
  'green_background',
  'blue_background',
  'purple_background',
  'pink_background',
  'red_background',
] as const

export const CalloutBlock: Story = {
  argTypes: {
    icon: { control: 'text' },
    color: { control: 'select', options: CALLOUT_COLORS },
  },
  args: { icon: '💡', color: 'default' },
  render: (args: Record<string, unknown>) => (
    <Page>
      {args.color === 'default' ? (
        <Callout icon={args.icon as string}>
          Tip: wrap every page in a `Page` so the notion-page scope applies.
        </Callout>
      ) : (
        <Callout
          icon={args.icon as string}
          color={args.color as Exclude<(typeof CALLOUT_COLORS)[number], 'default'>}
        >
          Tip: wrap every page in a `Page` so the notion-page scope applies.
        </Callout>
      )}
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

/**
 * Callout with no `icon` prop — the icon slot collapses entirely and only the
 * text column renders. Useful to see the default layout without the inline
 * icon affordance.
 */
export const CalloutWithoutIcon: Story = {
  render: () => (
    <Page>
      <Callout>
        No icon — the callout still renders its colored background (if any) and the text column; the
        icon slot is dropped.
      </Callout>
      <Callout color="gray_background">Same, with a gray_background color applied.</Callout>
    </Page>
  ),
}

/**
 * Empty Toggle — a collapsed `<details>` with no body. Documents the minimal
 * shape and lets hosts validate the baseline appearance of a closed toggle.
 */
export const EmptyToggle: Story = {
  render: () => (
    <Page>
      <Toggle title="Click to expand (there's nothing inside)" />
    </Page>
  ),
}
