import type { Meta, StoryObj } from '@storybook/react'

import { Bookmark, Callout, Heading1, Heading2, Page, Paragraph } from '../blocks.tsx'

const meta = {
  title: 'Demo/06 — Bookmarks',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Bookmarks</Heading1>
      <Paragraph>
        A bookmark block renders a link to an external resource. v0.1 only carries the URL — rich
        previews (title, description, thumbnail, favicon) and captions arrive with task{' '}
        <code>#76</code>.
      </Paragraph>

      <Heading2>Plain URL</Heading2>
      <Bookmark url="https://notion.so" />
      <Bookmark url="https://github.com/NotionX/react-notion-x" />
      <Bookmark url="https://effect.website" />

      <Heading2>Caption + preview metadata</Heading2>
      <Callout icon="🚧" color="yellow_background">
        v0.2 — not yet supported. Bookmark captions and crawled preview metadata are tracked by{' '}
        <code>#76</code> (media caption + file_upload).
      </Callout>
    </Page>
  ),
}
