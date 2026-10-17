import type { Meta, StoryObj } from '@storybook/react'

import { Callout, Heading1, Heading2, Page, Paragraph, SyncedBlock } from '../blocks.tsx'
import { InlineCode } from '../inline.tsx'

const meta = {
  title: 'Demo/13 — Modern · Synced Blocks',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

/**
 * Synced blocks share content between pages. v0.1 renders them via the `Raw`
 * passthrough (`SyncedBlock`). Full child resolution is tracked by #77.
 */
export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Synced blocks</Heading1>
      <Paragraph>
        A synced block carries the same content across multiple pages. The renderer exposes the raw
        payload via <InlineCode>SyncedBlock</InlineCode> until child resolution lands.
      </Paragraph>

      <Heading2>Original (source)</Heading2>
      <SyncedBlock
        content={{
          synced_from: null,
          children: [{ id: 'block-1', type: 'paragraph', text: 'This is synced source content.' }],
        }}
      />

      <Heading2>Mirror</Heading2>
      <SyncedBlock
        content={{
          synced_from: { block_id: 'block-1' },
          children: [],
        }}
      />

      <Callout icon="🚧" color="yellow_background">
        v0.2 — deep child resolution + Notion-style "Synced" affordance tracked by{' '}
        <InlineCode>#77</InlineCode>.
      </Callout>
    </Page>
  ),
}
