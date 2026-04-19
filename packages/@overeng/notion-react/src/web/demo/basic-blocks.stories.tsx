import type { Meta, StoryObj } from '@storybook/react'

import {
  Divider,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Page,
  Paragraph,
  Quote,
} from '../blocks.tsx'
import { Bold, InlineCode, Italic, Link, Strikethrough, Underline } from '../inline.tsx'

const meta = {
  title: 'Demo/01 — Basic Blocks',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Basic blocks</Heading1>
      <Paragraph>
        This is a paragraph with <Bold>bold</Bold>, <Italic>italic</Italic>,{' '}
        <Underline>underline</Underline>, <Strikethrough>strikethrough</Strikethrough>, and{' '}
        <InlineCode>inline code</InlineCode>. You can also embed a{' '}
        <Link href="https://notion.so">link</Link> mid-sentence.
      </Paragraph>
      <Heading2>Section heading</Heading2>
      <Paragraph>
        Headings keep a consistent vertical rhythm. The renderer maps each Notion heading to an
        <InlineCode>h1</InlineCode>–<InlineCode>h4</InlineCode> tag.
      </Paragraph>
      <Heading3>Subsection heading</Heading3>
      <Paragraph>h3 sits beneath h2 sections.</Paragraph>
      <Heading4>Nested heading</Heading4>
      <Paragraph>h4 is the deepest level supported by Notion's heading blocks.</Paragraph>
      <Paragraph>
        Inline annotations can nest:{' '}
        <Bold>
          <Italic>bold + italic</Italic>
        </Bold>
        , or{' '}
        <Italic>
          italic with a <Link href="https://example.com">link</Link> inside
        </Italic>
        .
      </Paragraph>
      <Divider />
      <Quote>
        A block quote is a short passage from another source, offset from surrounding prose.
      </Quote>
      <Paragraph>Trailing paragraph after the quote.</Paragraph>
    </Page>
  ),
}
