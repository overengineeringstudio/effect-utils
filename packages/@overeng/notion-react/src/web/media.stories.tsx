import type { Meta, StoryObj } from '@storybook/react'

import {
  Bookmark,
  ChildPage,
  Column,
  ColumnList,
  Embed,
  Equation,
  Image,
  LinkToPage,
  Page,
  Paragraph,
  Table,
  TableOfContents,
  TableRow,
} from './blocks.tsx'

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
      <Table>
        <TableRow>
          <td>App</td>
          <td>Time</td>
          <td>Category</td>
        </TableRow>
        <TableRow>
          <td>VSCode</td>
          <td>3h 12m</td>
          <td>coding</td>
        </TableRow>
        <TableRow>
          <td>Chrome</td>
          <td>1h 47m</td>
          <td>browsing</td>
        </TableRow>
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
