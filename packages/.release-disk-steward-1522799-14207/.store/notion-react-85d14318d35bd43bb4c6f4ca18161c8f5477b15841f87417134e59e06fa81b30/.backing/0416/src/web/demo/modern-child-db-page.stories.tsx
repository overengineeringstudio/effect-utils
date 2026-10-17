import type { Meta, StoryObj } from '@storybook/react'

import {
  Callout,
  ChildDatabase,
  ChildPage,
  Heading1,
  Heading2,
  LinkToPage,
  Page,
  Paragraph,
} from '../blocks.tsx'
import { InlineCode } from '../inline.tsx'

const meta = {
  title: 'Demo/18 — Modern · Child DB & Page',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

/**
 * Child pages + `link_to_page` are supported today. Embedded database views
 * (table, board, gallery) render via `ChildDatabase`'s Raw passthrough until
 * the collection renderer lands.
 */
export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Child DB & page</Heading1>

      <Heading2>Child page (supported)</Heading2>
      <ChildPage title="Team handbook" />
      <ChildPage title="Meeting notes — April 2026" />
      <ChildPage />

      <Heading2>link_to_page (supported)</Heading2>
      <LinkToPage pageId="page-abc-123" />
      <LinkToPage pageId="page-def-456" />

      <Heading2>Embedded database view</Heading2>
      <Paragraph>
        Notion emits a <InlineCode>child_database</InlineCode> block with a view schema (table,
        board, gallery). v0.1 surfaces the raw payload.
      </Paragraph>
      <ChildDatabase
        content={{
          title: 'Tasks',
          view: 'table',
          rows: 12,
        }}
      />

      <Callout icon="🚧" color="yellow_background">
        v0.2 — inline collection rendering (table / board / gallery / timeline) tracked by{' '}
        <InlineCode>#77</InlineCode>.
      </Callout>
    </Page>
  ),
}
