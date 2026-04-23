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

/**
 * Notion's modern column_list supports a per-column `width_ratio`. The v0.1
 * `ColumnProps` type does not yet carry that field, so this story renders
 * equal-width columns with a placeholder note linking to #77.
 */
export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Column widths</Heading1>
      <Paragraph>
        Modern column lists carry a <InlineCode>width_ratio</InlineCode> per column. Until the prop
        is plumbed through <InlineCode>ColumnProps</InlineCode>, the renderer draws equal-width
        columns.
      </Paragraph>

      <Heading2>Current (equal widths)</Heading2>
      <ColumnList>
        <Column>
          <Heading3>1fr</Heading3>
          <Paragraph>Left column at the default width.</Paragraph>
        </Column>
        <Column>
          <Heading3>1fr</Heading3>
          <Paragraph>Middle column at the default width.</Paragraph>
        </Column>
        <Column>
          <Heading3>1fr</Heading3>
          <Paragraph>Right column at the default width.</Paragraph>
        </Column>
      </ColumnList>

      <Callout icon="🚧" color="yellow_background">
        v0.2 — <InlineCode>width_ratio</InlineCode> plumbing tracked by <InlineCode>#77</InlineCode>
        . Notion emits e.g. <InlineCode>[0.5, 0.25, 0.25]</InlineCode> on a 3-column layout; the
        renderer will map those to <InlineCode>flex-grow</InlineCode> once the prop lands.
      </Callout>
    </Page>
  ),
}
