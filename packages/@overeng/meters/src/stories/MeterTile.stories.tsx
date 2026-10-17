import type { Meta, StoryObj } from '@storybook/react'
import * as React from 'react'
import { expect, userEvent, within } from 'storybook/test'

import {
  darkMeterTheme,
  freezeMeters,
  lightMeterTheme,
  type MeterFreeze,
  type MeterTheme,
} from '../canvas/index.ts'
import { MeterFreezeButton, MeterTile } from '../react/index.tsx'
import { makeStoryFixture, StoryCounter, StoryScope } from './fixtures.tsx'

const fixture = makeStoryFixture()

/** Six live tiles on real browser sources, or the same session with no tiles (`count: 0`). */
const TileRow = (props: { readonly theme: MeterTheme; readonly count: number }) => {
  const [freeze, setFreeze] = React.useState<MeterFreeze | undefined>(undefined)
  const tiles = fixture.tiles.slice(0, props.count)
  return (
    <StoryScope meters={fixture.meters}>
      <section
        aria-label="Meter tiles"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: 24,
          background: props.theme.background,
          color: props.theme.foreground,
        }}
      >
        <MeterFreezeButton
          frozenAtMs={freeze?.atMs}
          onToggle={() =>
            setFreeze(
              freeze === undefined
                ? freezeMeters({ meters: fixture.meters, blocks: tiles })
                : undefined,
            )
          }
          theme={props.theme}
        />
        {tiles.map((block) => (
          <MeterTile
            key={block.id}
            meters={fixture.meters}
            block={block}
            theme={props.theme}
            frozen={freeze}
            heightPx={30}
          />
        ))}
        <StoryCounter fixture={fixture} />
      </section>
    </StoryScope>
  )
}

const meta = {
  title: 'meters/MeterTile',
  component: TileRow,
  parameters: { layout: 'centered' },
  args: { theme: lightMeterTheme, count: 6 },
} satisfies Meta<typeof TileRow>
export default meta
type Story = StoryObj<typeof meta>

/** Six tiles on one shared frame clock; keyboard evidence, refresh and freeze. */
export const Light: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const tile = canvas.getByRole('button', { name: 'clicks' })
    await expect(tile).toHaveAttribute('title', 'Clicks')
    await userEvent.click(canvas.getByRole('button', { name: 'Increment counter (0)' }))
    tile.focus()
    const card = await canvas.findByRole('tooltip')
    await expect(card).toHaveTextContent('Snapshot taken on focus')
    await userEvent.keyboard('{Enter}')
    await expect(canvas.getByRole('tooltip')).toHaveTextContent('Snapshot taken on activation')
    await userEvent.keyboard('R')
    await expect(canvas.getByRole('tooltip')).toHaveTextContent('Snapshot refreshed')
    const freeze = canvas.getByRole('button', { name: 'Freeze meters' })
    await userEvent.click(freeze)
    await expect(freeze).toHaveAttribute('aria-pressed', 'true')
    tile.focus()
    await expect(await canvas.findByRole('tooltip')).toHaveTextContent('(frozen)')
    await userEvent.click(freeze)
    await expect(freeze).toHaveAttribute('aria-pressed', 'false')
  },
}

/** The identical tiles in the semantic dark theme. */
export const Dark: Story = { args: { theme: darkMeterTheme } }

/** Unscripted six-tile surface for browser automation and frame-cost measurement. */
export const Live: Story = {}

/** The same session and sources without tiles: the frame-cost baseline. */
export const Baseline: Story = { args: { count: 0 } }
