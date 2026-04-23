import type { Meta, StoryObj } from '@storybook/react'

import {
  BulletedListItem,
  Callout,
  Code,
  Column,
  ColumnList,
  Divider,
  Heading1,
  Heading2,
  Heading3,
  Page,
  Paragraph,
  Quote,
} from '../blocks.tsx'
import { Bold, Italic } from '../inline.tsx'

const meta = {
  title: 'Demo/09 — Column Layouts',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Column layouts</Heading1>

      <Heading2>Two columns</Heading2>
      <ColumnList>
        <Column>
          <Heading3>Pros</Heading3>
          <BulletedListItem>Clear prop types shared with the renderer</BulletedListItem>
          <BulletedListItem>
            <Bold>No</Bold> runtime reflection cost
          </BulletedListItem>
          <BulletedListItem>Stable CSS hooks</BulletedListItem>
        </Column>
        <Column>
          <Heading3>Cons</Heading3>
          <BulletedListItem>Preview only — not pixel-perfect Notion</BulletedListItem>
          <BulletedListItem>
            <Italic>No</Italic> nested children yet
          </BulletedListItem>
          <BulletedListItem>Requires CSS import</BulletedListItem>
        </Column>
      </ColumnList>

      <Divider />

      <Heading2>Three columns</Heading2>
      <ColumnList>
        <Column>
          <Heading3>Input</Heading3>
          <Paragraph>A Notion page, fetched via the Notion API.</Paragraph>
          <Code language="ts">{`const page = await notion.pages.retrieve({
  page_id: pageId,
})`}</Code>
        </Column>
        <Column>
          <Heading3>Transform</Heading3>
          <Paragraph>Blocks become React elements via the renderer.</Paragraph>
          <Callout icon="⚙️" color="blue_background">
            One block type per component.
          </Callout>
        </Column>
        <Column>
          <Heading3>Output</Heading3>
          <Paragraph>DOM that mirrors react-notion-x's class names.</Paragraph>
          <Quote>
            <Italic>Structural</Italic> parity, not pixel parity.
          </Quote>
        </Column>
      </ColumnList>
    </Page>
  ),
}
