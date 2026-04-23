import type { Meta, StoryObj } from '@storybook/react'

import { Heading1, Heading2, Page, Paragraph } from '../blocks.tsx'
import { Color, InlineCode } from '../inline.tsx'

const meta = {
  title: 'Demo/19 — Modern · Color Palette',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

const colors = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const

export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Modern color palette</Heading1>
      <Paragraph>
        Every Notion color (including modern additions), applied as foreground and as background.
        The <InlineCode>Color</InlineCode> inline wraps a run of text; callouts use the same token
        set via their <InlineCode>color</InlineCode> prop.
      </Paragraph>

      <Heading2>Foreground</Heading2>
      {colors.map((c) => (
        <Paragraph key={c}>
          <Color value={c}>
            The quick brown fox jumps over the lazy dog — <InlineCode>{c}</InlineCode>
          </Color>
        </Paragraph>
      ))}

      <Heading2>Background</Heading2>
      {colors
        .filter((c) => c !== 'default')
        .map((c) => (
          <Paragraph key={`${c}_bg`}>
            <Color value={`${c}_background`}>
              The quick brown fox jumps over the lazy dog —{' '}
              <InlineCode>{`${c}_background`}</InlineCode>
            </Color>
          </Paragraph>
        ))}
    </Page>
  ),
}
