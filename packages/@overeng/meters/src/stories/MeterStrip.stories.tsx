import type { Meta, StoryObj } from '@storybook/react'
import * as React from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'

import { darkMeterTheme, lightMeterTheme, type MeterTheme } from '../canvas/index.ts'
import { MeterStrip } from '../react/index.tsx'
import { makeStoryFixture, StoryCounter, StoryScope, StorySibling } from './fixtures.tsx'

const fixture = makeStoryFixture()

const StripView = (props: { readonly theme: MeterTheme }) => {
  const [frozen, setFrozen] = React.useState(false)
  const [details, setDetails] = React.useState<readonly string[]>([])
  return (
    <StoryScope meters={fixture.meters}>
      <section
        style={{ padding: 24, background: props.theme.background, color: props.theme.foreground }}
      >
        <MeterStrip
          meters={fixture.meters}
          blocks={fixture.blocks}
          theme={props.theme}
          frozen={frozen}
          onFrozenChange={setFrozen}
          onOpenDetail={({ id }) => {
            setDetails((current) => [...current, id])
            // The host owns detail navigation; the story logs that boundary rather than opening a fake panel.
            console.info('Open meter detail', { id })
          }}
        />
        <StoryCounter fixture={fixture} />
        <StorySibling fixture={fixture} />
        <output aria-label="Detail requests">
          {details.length === 0 ? 'None' : details.join(', ')}
        </output>
      </section>
    </StoryScope>
  )
}

const meta = {
  title: 'meters/MeterStrip',
  component: StripView,
  parameters: { layout: 'centered' },
  args: { theme: lightMeterTheme },
} satisfies Meta<typeof StripView>
export default meta
type Story = StoryObj<typeof meta>

/** Real frames, capability-detected long frames/heap, user counter, and Profiler callbacks. */
export const Light: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Increment counter (0)' }))
    await expect(canvas.getByRole('button', { name: 'Increment counter (1)' })).toBeVisible()
    await waitFor(() => expect(canvas.getByLabelText('Clicks')).not.toHaveTextContent('n/a'))
    await userEvent.click(canvas.getByRole('button', { name: 'Freeze meters' }))
    await expect(canvas.getByRole('button', { name: 'Resume meters' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await userEvent.click(canvas.getByRole('button', { name: /^Frames:/ }))
    await expect(canvas.getByLabelText('Detail requests')).toHaveTextContent('story.frames')
    await userEvent.click(canvas.getByRole('button', { name: 'Resume meters' }))
  },
}

/** The identical sources and strip in the semantic dark theme. */
export const Dark: Story = { ...Light, args: { theme: darkMeterTheme } }

/** Two independent renderer views share the same sources, histories, and frame clock. */
export const AllStates: Story = {
  render: () => (
    <div>
      <h2>Light</h2>
      <StripView theme={lightMeterTheme} />
      <h2>Dark</h2>
      <StripView theme={darkMeterTheme} />
    </div>
  ),
}

/** Unscripted host surface for browser automation and manual measurements. */
export const Live: Story = {}
