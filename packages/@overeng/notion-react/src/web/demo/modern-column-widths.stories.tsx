import type { Meta, StoryObj } from '@storybook/react'

import {
  Callout,
  Column,
  ColumnList,
  Heading1,
  Heading2,
  Heading3,
  Page,
  Paragraph,
} from '../blocks.tsx'
import { InlineCode } from '../inline.tsx'

const meta = {
  title: 'Demo/12 — Modern · Column Widths',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Column widths</Heading1>
      <Paragraph>
        Modern column lists carry a <InlineCode>width_ratio</InlineCode> per column, exposed here as{' '}
        <InlineCode>widthRatio</InlineCode>. The web renderer maps it to flex growth and the host
        renderer projects it as Notion&apos;s native <InlineCode>width_ratio</InlineCode>, but live
        Notion append still rejects that field today.
      </Paragraph>

      <Heading2>2 : 1 split</Heading2>
      <ColumnList>
        <Column widthRatio={2}>
          <Heading3>Wide column</Heading3>
          <Paragraph>
            The primary content column uses <InlineCode>widthRatio=2</InlineCode>.
          </Paragraph>
        </Column>
        <Column widthRatio={1}>
          <Heading3>Sidebar</Heading3>
          <Paragraph>
            The secondary column uses <InlineCode>widthRatio=1</InlineCode>.
          </Paragraph>
        </Column>
      </ColumnList>

      <Heading2>1 : 2 : 1 split</Heading2>
      <ColumnList>
        <Column widthRatio={1}>
          <Heading3>Left rail</Heading3>
          <Paragraph>Small supporting context.</Paragraph>
        </Column>
        <Column widthRatio={2}>
          <Heading3>Main content</Heading3>
          <Paragraph>The center column gets twice the growth budget of either side rail.</Paragraph>
        </Column>
        <Column widthRatio={1}>
          <Heading3>Right rail</Heading3>
          <Paragraph>Secondary metadata and actions.</Paragraph>
        </Column>
      </ColumnList>

      <Callout icon="🚧" color="yellow_background">
        Storybook and host projection support are in place, but the public Notion API currently
        rejects column <InlineCode>width_ratio</InlineCode> on append. Keep this as a local preview
        surface until live support is proven.
      </Callout>
    </Page>
  ),
}
