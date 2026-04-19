import type { Meta, StoryObj } from '@storybook/react'

import { Callout, Heading1, Heading2, Page, Paragraph, Raw } from '../blocks.tsx'
import { InlineCode } from '../inline.tsx'

const meta = {
  title: 'Demo/11 — Modern · Tabs',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

/**
 * Notion's modern "tab" block. v0.1 exposes it via the `Raw` escape hatch;
 * a dedicated `Tabs` component with tab-switch semantics is tracked by #67.
 */
export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Tabs</Heading1>
      <Paragraph>
        Notion's modern tab block renders as a set of switchable panels. Today the renderer surfaces
        raw tab payloads via the <InlineCode>Raw</InlineCode> escape hatch.
      </Paragraph>

      <Heading2>Raw payload</Heading2>
      <Raw
        type="tab"
        content={{
          title: 'Overview',
          children: ['paragraph-1', 'paragraph-2'],
        }}
      />
      <Raw
        type="tab"
        content={{
          title: 'Details',
          children: ['heading-1', 'bulleted-list'],
        }}
      />
      <Raw
        type="tab"
        content={{
          title: 'FAQ',
          children: ['toggle-1', 'toggle-2'],
        }}
      />

      <Callout icon="🚧" color="yellow_background">
        A typed <InlineCode>Tabs</InlineCode> component with switch semantics is tracked by{' '}
        <InlineCode>#67</InlineCode> (Raw escape hatch follow-up).
      </Callout>
    </Page>
  ),
}
