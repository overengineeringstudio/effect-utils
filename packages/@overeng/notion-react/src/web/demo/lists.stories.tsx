import type { Meta, StoryObj } from '@storybook/react'

import {
  BulletedListItem,
  Callout,
  Heading1,
  Heading2,
  NumberedListItem,
  Page,
  Paragraph,
  ToDo,
} from '../blocks.tsx'
import { Bold } from '../inline.tsx'

const meta = {
  title: 'Demo/02 — Lists',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Lists</Heading1>

      <Heading2>Bulleted</Heading2>
      <BulletedListItem>Apples</BulletedListItem>
      <BulletedListItem>
        Oranges with <Bold>emphasis</Bold>
      </BulletedListItem>
      <BulletedListItem>Bananas</BulletedListItem>

      <Heading2>Numbered</Heading2>
      <NumberedListItem>Gather ingredients</NumberedListItem>
      <NumberedListItem>Preheat oven to 180°C</NumberedListItem>
      <NumberedListItem>Bake for 25 minutes</NumberedListItem>

      <Heading2>To-do</Heading2>
      <ToDo checked>Write spec</ToDo>
      <ToDo checked>Implement renderer</ToDo>
      <ToDo>Publish changelog</ToDo>

      <Heading2>Nesting</Heading2>
      <Callout icon="ℹ️" color="gray_background">
        v0.1 renders list items as independent blocks; true nested <Bold>children</Bold> within a
        single list item land with task <Bold>#62</Bold> / <Bold>#74</Bold>. Until then, stack
        sibling items to approximate structure.
      </Callout>
      <Paragraph>Stacked approximation:</Paragraph>
      <BulletedListItem>Fruit</BulletedListItem>
      <BulletedListItem>— Apples</BulletedListItem>
      <BulletedListItem>— Oranges</BulletedListItem>
      <BulletedListItem>Vegetables</BulletedListItem>
      <BulletedListItem>— Carrots</BulletedListItem>
    </Page>
  ),
}
