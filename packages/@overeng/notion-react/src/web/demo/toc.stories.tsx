import type { Meta, StoryObj } from '@storybook/react'

import { Heading1, Heading2, Heading3, Page, Paragraph, TableOfContents } from '../blocks.tsx'

const meta = {
  title: 'Demo/05 — Table of Contents',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Table of contents</Heading1>
      <Paragraph>
        A <code>table_of_contents</code> block anchors to every heading on the page. Nested headings
        appear indented.
      </Paragraph>
      <TableOfContents />

      <Heading2>Introduction</Heading2>
      <Paragraph>Setting the stage for what follows.</Paragraph>

      <Heading2>Background</Heading2>
      <Paragraph>Prior art and relevant context.</Paragraph>
      <Heading3>Related work</Heading3>
      <Paragraph>A non-exhaustive survey.</Paragraph>
      <Heading3>Prior attempts</Heading3>
      <Paragraph>What has and has not worked before.</Paragraph>

      <Heading2>Method</Heading2>
      <Paragraph>The approach in detail.</Paragraph>

      <Heading2>Results</Heading2>
      <Paragraph>Observed outcomes.</Paragraph>

      <Heading2>Conclusion</Heading2>
      <Paragraph>Wrap-up and next steps.</Paragraph>
    </Page>
  ),
}
