import type { Meta, StoryObj } from '@storybook/react'

import { Heading1, Heading2, LinkToPage, Page, Paragraph } from '../blocks.tsx'
import { InlineCode, Link, Mention } from '../inline.tsx'

const meta = {
  title: 'Demo/07 — Links',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Links</Heading1>

      <Heading2>Inline links</Heading2>
      <Paragraph>
        A paragraph can contain a <Link href="https://notion.so">plain link</Link>, a{' '}
        <Link href="https://github.com">second link</Link>, or a link wrapping{' '}
        <Link href="https://example.com">
          <InlineCode>code</InlineCode>
        </Link>
        .
      </Paragraph>

      <Heading2>External links</Heading2>
      <Paragraph>
        External links open in a new tab with <InlineCode>rel="noreferrer noopener"</InlineCode>:{' '}
        <Link href="https://react-notion-x-demo.transitivebullsh.it/">react-notion-x demo</Link>.
      </Paragraph>

      <Heading2>Page mentions</Heading2>
      <Paragraph>
        Inline page mention:{' '}
        <Mention mention={{ page: { id: 'page-123' } }} plainText="@Project roadmap" />. User
        mention: <Mention mention={{ user: { id: 'u-1' } }} plainText="@alex" />. Date mention:{' '}
        <Mention mention={{ date: { start: '2026-04-19' } }} plainText="@2026-04-19" />.
      </Paragraph>

      <Heading2>link_to_page block</Heading2>
      <Paragraph>A standalone link-to-page block renders as a navigable row:</Paragraph>
      <LinkToPage pageId="page-abc-123" />
      <LinkToPage pageId="page-def-456" />
    </Page>
  ),
}
