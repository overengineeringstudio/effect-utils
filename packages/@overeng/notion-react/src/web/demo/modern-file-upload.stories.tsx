import type { Meta, StoryObj } from '@storybook/react'

import { Callout, File, Heading1, Heading2, Page, Paragraph, Pdf } from '../blocks.tsx'
import { InlineCode } from '../inline.tsx'

const meta = {
  title: 'Demo/15 — Modern · File Upload',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

/**
 * Notion-hosted files (images, PDFs, attachments) land via the `file_upload`
 * endpoint with signed URLs. v0.1 renders external URLs; the Notion-hosted
 * variant (signing, caption, download affordances) is tracked by #76.
 */
export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>File upload</Heading1>
      <Paragraph>
        External URLs already render today. Notion-hosted files (signed URLs from the{' '}
        <InlineCode>file_upload</InlineCode> endpoint) with caption and download metadata are
        tracked by <InlineCode>#76</InlineCode>.
      </Paragraph>

      <Heading2>Today — external URL</Heading2>
      <File url="https://example.com/spec.pdf" />
      <Pdf url="https://example.com/whitepaper.pdf" />

      <Heading2>v0.2 — Notion-hosted</Heading2>
      <Callout icon="🚧" color="yellow_background">
        Signed-URL file uploads, caption rendering, and download affordances tracked by{' '}
        <InlineCode>#76</InlineCode>. This is distinct from the external-URL variant above.
      </Callout>
    </Page>
  ),
}
