import type { Meta, StoryObj } from '@storybook/react'

import { Callout, Heading1, Heading2, LinkPreview, Page, Paragraph } from '../blocks.tsx'
import { InlineCode } from '../inline.tsx'

const meta = {
  title: 'Demo/16 — Modern · Link Preview',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

/**
 * Rich external link previews (GitHub issues, Figma files, tweets) land via
 * Notion's `link_preview` integration. v0.1 passes the raw payload through;
 * authenticated preview rendering is tracked by #77.
 */
export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Link preview</Heading1>
      <Paragraph>
        Link previews render rich metadata for URLs backed by Notion integrations (GitHub, Figma,
        Jira, tweets, etc.). v0.1 passes the payload through without fetching.
      </Paragraph>

      <Heading2>Raw payload</Heading2>
      <LinkPreview
        content={{
          url: 'https://github.com/NotionX/react-notion-x/pull/123',
          provider: 'github',
          title: 'Fix: stable anchor IDs for TOC entries',
        }}
      />
      <LinkPreview
        content={{
          url: 'https://www.figma.com/file/abc/Design-System',
          provider: 'figma',
          title: 'Design System v3',
        }}
      />

      <Callout icon="🚧" color="yellow_background">
        v0.2 — authenticated preview fetching and rendering tracked by <InlineCode>#77</InlineCode>.
      </Callout>
    </Page>
  ),
}
