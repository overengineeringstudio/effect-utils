import type { Meta, StoryObj } from '@storybook/react'

import { Callout, Heading1, Heading2, Page, Paragraph } from '../blocks.tsx'
import { InlineCode } from '../inline.tsx'

const meta = {
  title: 'Demo/10 — Placeholders (v0.2)',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

/**
 * Each story below renders a single "v0.2 — not yet supported" callout for
 * a feature that the react-notion-x showcase exercises but that our v0.1
 * renderer does not yet cover. The referenced task IDs are the GitHub
 * issues tracking the work.
 */

type PlaceholderProps = {
  readonly feature: string
  readonly summary: string
  readonly task: string
}

const Placeholder = ({ feature, summary, task }: PlaceholderProps) => (
  <Page>
    <Heading1>{feature}</Heading1>
    <Paragraph>{summary}</Paragraph>
    <Callout icon="🚧" color="yellow_background">
      <Heading2>v0.2 — not yet supported</Heading2>
      <Paragraph>
        Tracked by <InlineCode>{task}</InlineCode>. Until then the renderer falls back to a minimal
        placeholder or a <InlineCode>Raw</InlineCode> passthrough where applicable.
      </Paragraph>
    </Callout>
  </Page>
)

export const Collections: Story = {
  render: () => (
    <Placeholder
      feature="Collections — databases, views, galleries"
      summary="Inline databases, table/board/gallery views, and filtered queries that the react-notion-x demo showcases as 'Collections'."
      task="#77"
    />
  ),
}

export const SyncBlocks: Story = {
  render: () => (
    <Placeholder
      feature="Sync blocks"
      summary="Blocks whose contents are shared between multiple pages via Notion's sync mechanism."
      task="#77"
    />
  ),
}

export const ImageUpload: Story = {
  render: () => (
    <Placeholder
      feature="Image upload"
      summary="Images sourced from Notion's file_upload mechanism rather than external URLs."
      task="#76"
    />
  ),
}

export const FileUploads: Story = {
  render: () => (
    <Placeholder
      feature="File uploads beyond URL"
      summary="PDFs, audio, video, and generic files stored via Notion's file_upload endpoint (signed URLs, caption rendering, download affordances)."
      task="#76"
    />
  ),
}

export const TweetEmbeds: Story = {
  render: () => (
    <Placeholder
      feature="Tweet embeds"
      summary="Embedded tweets with author, body, timestamp, and interaction counts."
      task="#77"
    />
  ),
}

export const YouTubeEmbeds: Story = {
  render: () => (
    <Placeholder
      feature="YouTube embeds"
      summary="Inline YouTube player with thumbnail, title, and responsive aspect-ratio handling."
      task="#77"
    />
  ),
}

export const Buttons: Story = {
  render: () => (
    <Placeholder
      feature="Buttons"
      summary="Notion's button block with configurable label, style, and action."
      task="#77"
    />
  ),
}

export const Tables: Story = {
  render: () => (
    <Placeholder
      feature="Simple tables with header / merged cells"
      summary="A simple_table block with header rows, column-header formatting, and rich-text cell content."
      task="#75"
    />
  ),
}

export const NestedChildren: Story = {
  render: () => (
    <Placeholder
      feature="Nested block children"
      summary="Arbitrarily deep trees of blocks — a toggle containing a list containing a callout containing a paragraph, etc."
      task="#74"
    />
  ),
}

export const RawEscapeHatch: Story = {
  render: () => (
    <Placeholder
      feature="Raw escape hatch"
      summary="A typed pass-through that lets consumers render arbitrary Notion block JSON without adding a component."
      task="#67"
    />
  ),
}
