import type { Meta, StoryObj } from '@storybook/react'

import {
  BulletedListItem,
  Column,
  ColumnList,
  Divider,
  Heading1,
  Heading2,
  Page,
  Paragraph,
} from '../blocks.tsx'
import { Italic } from '../inline.tsx'

/**
 * Mirrors the Features index of the react-notion-x showcase
 * (https://react-notion-x-demo.transitivebullsh.it/). Each entry links
 * conceptually to a sibling story in this Demo/ category.
 */
const meta = {
  title: 'Demo/00 — Features Index',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

type Feature = { readonly emoji: string; readonly label: string }

const basic: readonly Feature[] = [
  { emoji: '🔤', label: 'Basic blocks — headings, text, dividers, quotes' },
  { emoji: '📋', label: 'Lists — bulleted, numbered, nested' },
  { emoji: '🌈', label: 'Color rainbow — every callout color swatch' },
  { emoji: '💻', label: 'Code blocks — multiple languages' },
  { emoji: '📑', label: 'Table of contents — auto from headings' },
  { emoji: '🔖', label: 'Bookmarks — URL previews with captions' },
  { emoji: '🔗', label: 'Links — inline, external, mentions' },
]

const advanced: readonly Feature[] = [
  { emoji: '➗', label: 'Math & equations — inline and block KaTeX' },
  { emoji: '🧱', label: 'Column layouts — 2 and 3 column grids' },
  { emoji: '🚧', label: 'Placeholders — v0.2 unsupported features' },
]

export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Features</Heading1>
      <Paragraph>
        A tour of what the <Italic>@overeng/notion-react</Italic> web renderer can draw today. Each
        row below links to a self-contained story exercising a single category.
      </Paragraph>
      <Divider />
      <ColumnList>
        <Column>
          <Heading2>Basic</Heading2>
          {basic.map((f) => (
            <BulletedListItem key={f.label}>
              {f.emoji} {f.label}
            </BulletedListItem>
          ))}
        </Column>
        <Column>
          <Heading2>Advanced</Heading2>
          {advanced.map((f) => (
            <BulletedListItem key={f.label}>
              {f.emoji} {f.label}
            </BulletedListItem>
          ))}
        </Column>
      </ColumnList>
    </Page>
  ),
}
