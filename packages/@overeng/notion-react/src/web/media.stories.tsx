import type { Meta, StoryObj } from '@storybook/react'

import {
  Audio,
  Bookmark,
  Breadcrumb,
  ChildDatabase,
  ChildPage,
  Column,
  ColumnList,
  Embed,
  Equation,
  File,
  Image,
  LinkPreview,
  LinkToPage,
  Page,
  Paragraph,
  Pdf,
  Raw,
  SyncedBlock,
  Table,
  TableOfContents,
  TableRow,
  Template,
  Video,
} from './blocks.tsx'
import { InlineCode } from './inline.tsx'

const meta = { title: 'Media & Layout' } satisfies Meta
export default meta

type Story = StoryObj

export const ImageBlock: Story = {
  render: () => (
    <Page>
      <Image
        url="https://images.unsplash.com/photo-1523961131990-5ea7c61b2107?w=800&q=80"
        caption="a tree, in a forest, near a river"
      />
      <Image caption="no url — shows an empty placeholder" />
    </Page>
  ),
}

export const BookmarkEmbed: Story = {
  render: () => (
    <Page>
      <Bookmark url="https://notion.so" />
      <Embed url="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />
    </Page>
  ),
}

export const EquationBlock: Story = {
  render: () => (
    <Page>
      <Equation expression="e^{i\pi} + 1 = 0" />
      <Equation expression="\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}" />
    </Page>
  ),
}

export const TableBlock: Story = {
  render: () => (
    <Page>
      <Table tableWidth={3} hasColumnHeader>
        <TableRow cells={['Tier', 'Price', 'Highlight']} />
        <TableRow cells={['Nimbus One', '$89', 'Core dimming + app control']} />
        <TableRow cells={['Nimbus Plus', '$129', 'Adds color temperature']} />
      </Table>
    </Page>
  ),
}

export const Columns: Story = {
  render: () => (
    <Page>
      <ColumnList>
        <Column>
          <Paragraph>Left column content.</Paragraph>
        </Column>
        <Column>
          <Paragraph>Middle column content.</Paragraph>
        </Column>
        <Column>
          <Paragraph>Right column content.</Paragraph>
        </Column>
      </ColumnList>
    </Page>
  ),
}

export const Navigation: Story = {
  render: () => (
    <Page>
      <TableOfContents />
      <LinkToPage pageId="abc-123" />
      <ChildPage title="Sub-page: architecture notes" />
      <ChildPage />
    </Page>
  ),
}

/**
 * Media blocks beyond `<Image>`: video, audio, file, and PDF. The web mirror
 * wraps each in `<figure class="notion-media ...">` and delegates to the native
 * HTML5 element — there is no Notion-specific player chrome.
 */
export const VideoBlock: Story = {
  render: () => (
    <Page>
      <Video
        url="https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"
        caption="Big Buck Bunny — short reference clip"
      />
    </Page>
  ),
}

export const AudioBlock: Story = {
  render: () => (
    <Page>
      <Audio
        url="https://commons.wikimedia.org/wiki/Special:FilePath/En-us-hello.ogg"
        caption="Short spoken sample"
      />
    </Page>
  ),
}

export const FileBlock: Story = {
  render: () => (
    <Page>
      <Paragraph>
        <InlineCode>&lt;File&gt;</InlineCode> renders as a plain anchor — hosts can wrap it to add
        richer affordances.
      </Paragraph>
      <File url="https://www.w3.org/TR/PNG/iso_8859-1.txt" caption="sample file" />
    </Page>
  ),
}

export const PdfBlock: Story = {
  render: () => (
    <Page>
      <Pdf
        url="https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"
        caption="sample PDF"
      />
    </Page>
  ),
}

/**
 * Passthrough blocks (`Raw`, `Template`, `LinkPreview`, `SyncedBlock`,
 * `ChildDatabase`, `Breadcrumb`): these are surfaces the web mirror does not
 * fully project. They render their payload inline as JSON inside a dashed
 * `.notion-raw` box so reviewers can tell at a glance that the content is
 * preserved but not rendered. Hosts that need richer rendering should swap
 * these components out at their module boundary.
 */
export const PassthroughBlocks: Story = {
  render: () => (
    <Page>
      <Paragraph>
        These components are intentionally rendered as JSON-in-a-box — see the component docs for
        the rationale.
      </Paragraph>
      <Raw type="my_custom_type" content={{ note: 'raw payload preserved through the pipeline' }} />
      <Template content={{ template: { rich_text: [{ text: { content: 'New task' } }] } }} />
      <LinkPreview content={{ url: 'https://github.com/overengineeringstudio/effect-utils' }} />
      <SyncedBlock content={{ synced_from: { block_id: 'block-id-xyz' } }} />
      <ChildDatabase content={{ title: 'Tasks (database)' }} />
      <Breadcrumb />
    </Page>
  ),
}
