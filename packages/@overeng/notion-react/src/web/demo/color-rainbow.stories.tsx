import type { Meta, StoryObj } from '@storybook/react'

import { Callout, Heading1, Heading2, Page, Paragraph } from '../blocks.tsx'

const meta = {
  title: 'Demo/03 — Color Rainbow',
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
      <Heading1>Color rainbow</Heading1>
      <Paragraph>Every supported callout color, foreground then background.</Paragraph>

      <Heading2>Foreground</Heading2>
      {colors.map((c) => (
        <Callout key={c} icon="🎨" color={c}>
          Callout color <code>{c}</code> — the quick brown fox jumps over the lazy dog.
        </Callout>
      ))}

      <Heading2>Background</Heading2>
      {colors
        .filter((c) => c !== 'default')
        .map((c) => (
          <Callout key={`${c}_bg`} icon="🖍" color={`${c}_background`}>
            Callout color <code>{`${c}_background`}</code> — the quick brown fox jumps over the lazy
            dog.
          </Callout>
        ))}
    </Page>
  ),
}
