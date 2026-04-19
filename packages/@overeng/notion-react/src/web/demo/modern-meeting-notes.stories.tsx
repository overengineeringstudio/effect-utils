import type { Meta, StoryObj } from '@storybook/react'

import { Callout, Heading1, Page, Paragraph, Raw } from '../blocks.tsx'
import { Bold, InlineCode } from '../inline.tsx'

const meta = {
  title: 'Demo/14 — Modern · Meeting Notes',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

/**
 * Notion's meeting notes block is a server-driven, read-only view aggregating
 * attendees, agenda, and transcript. v0.1 renders it as a `Raw` payload with
 * a note that write semantics are out of scope.
 */
export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Meeting notes</Heading1>
      <Paragraph>
        Meeting notes are a modern Notion block composed server-side from calendar + transcript
        sources. The renderer treats them as <Bold>read-only</Bold>; write semantics are owned by
        the Notion host app.
      </Paragraph>

      <Raw
        type="meeting_notes"
        content={{
          title: 'Design sync — April 19',
          attendees: ['alex', 'priya', 'jamie'],
          transcript_url: 'https://example.com/transcript',
        }}
      />

      <Callout icon="ℹ️" color="blue_background">
        v0.2 — this block is intentionally <Bold>read-only / server-only</Bold>. There is no plan to
        emit mutation events from the renderer; the host app will keep ownership. A typed read-view
        component is tracked by <InlineCode>#77</InlineCode>.
      </Callout>
    </Page>
  ),
}
