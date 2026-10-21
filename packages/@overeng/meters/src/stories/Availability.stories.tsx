import type { Meta, StoryObj } from '@storybook/react'
import * as React from 'react'
import { expect, waitFor, within } from 'storybook/test'

import { heapBlock, lightMeterTheme } from '../canvas/index.ts'
import { makeMeters, makeSeries } from '../index.ts'
import { makeBrowserPlatform } from '../platform/browser.ts'
import { MeterStrip } from '../react/index.tsx'
import { heapSource, type HeapMemory } from '../sources/memory/index.ts'
import { StoryScope } from './fixtures.tsx'

const heap = makeSeries<HeapMemory>({
  id: 'availability.heap',
  label: 'JS heap (approximate)',
  unit: 'bytes',
  capacity: 40,
})
const meters = makeMeters({
  platform: makeBrowserPlatform(),
  sources: [
    heapSource({
      id: 'availability.heap',
      series: heap,
      everyMs: 250,
      // Inject a real performance coordinate with the optional heap API absent; never synthesize a sample.
      browser: () => ({
        performance: { now: () => performance.now(), timeOrigin: performance.timeOrigin },
      }),
    }),
  ],
})
const blocks = [heapBlock({ id: 'availability.heap', series: heap })]

const AvailabilityView = () => {
  const [frozen, setFrozen] = React.useState(false)
  const [detail, setDetail] = React.useState('None')
  return (
    <StoryScope meters={meters}>
      <p>This browser environment has no performance.memory capability.</p>
      <MeterStrip
        meters={meters}
        blocks={blocks}
        theme={lightMeterTheme}
        frozen={frozen}
        onFrozenChange={setFrozen}
        onOpenDetail={({ id }) => setDetail(id)}
      />
      <output aria-label="Detail request">{detail}</output>
    </StoryScope>
  )
}

const meta = {
  title: 'meters/Availability',
  component: AvailabilityView,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof AvailabilityView>
export default meta
type Story = StoryObj<typeof meta>

/** Missing capability is explicit n/a, not a healthy zero. */
export const UnsupportedHeap: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByLabelText('JS heap (approximate)')).toHaveTextContent('n/a (Unsupported)'),
    )
  },
}

/** Availability evidence and keyboard targets use the same production strip. */
export const AllStates: Story = { ...UnsupportedHeap }
