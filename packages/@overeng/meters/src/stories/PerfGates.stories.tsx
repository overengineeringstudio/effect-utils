import type { Meta, StoryObj } from '@storybook/react'
import { Cause, Effect, Fiber } from 'effect'
import * as React from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'

import { lightMeterTheme } from '../canvas/index.ts'
import { makeMeters, type MeasureResult } from '../headless/index.ts'
import { makeBrowserPlatform } from '../platform/browser.ts'
import { MeterStrip } from '../react/index.tsx'
import { makeStoryFixture, StoryCounter, StoryScope, StorySibling } from './fixtures.tsx'

const fixture = makeStoryFixture()
const unconfigured = makeMeters({ sources: [], platform: makeBrowserPlatform() })

type GateState =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Running' }
  | { readonly _tag: 'Measured'; readonly measurement: MeasureResult }
  | { readonly _tag: 'Failed'; readonly cause: string }

const PerfGateView = (props: { readonly configured: boolean }) => {
  const meters = props.configured === true ? fixture.meters : unconfigured
  const [state, setState] = React.useState<GateState>({ _tag: 'Idle' })
  const [frozen, setFrozen] = React.useState(false)
  const [detail, setDetail] = React.useState('None')
  const active = React.useRef<Fiber.Fiber<void, never> | undefined>(undefined)
  const attach = React.useCallback((host: HTMLDivElement | null) => {
    if (host === null) return
    return () => {
      if (active.current !== undefined) Effect.runFork(Fiber.interrupt(active.current))
    }
  }, [])
  const measure = (blocking: boolean): void => {
    setState({ _tag: 'Running' })
    const program = Effect.gen(function* () {
      yield* meters.start
      const { measurement } = yield* meters.headless.measureWindow({
        work: Effect.sync(() => {
          if (props.configured === true)
            fixture.instrumentation.counter({ token: fixture.clicks }).add({ by: 1 })
          if (blocking === true) {
            const started = performance.now()
            while (performance.now() - started < 250) {
              /* Deliberately starve the real browser frame clock. */
            }
          }
        }),
        settleFrames: props.configured === true ? 30 : 0,
      })
      setState({ _tag: 'Measured', measurement })
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterruptsOnly(cause) === false)
            setState({ _tag: 'Failed', cause: Cause.pretty(cause) })
        }),
      ),
    )
    active.current = Effect.runFork(program)
  }
  return (
    <StoryScope meters={meters}>
      <div ref={attach}>
        {props.configured === true && (
          <>
            <MeterStrip
              meters={meters}
              blocks={fixture.blocks}
              theme={lightMeterTheme}
              frozen={frozen}
              onFrozenChange={setFrozen}
              onOpenDetail={({ id }) => setDetail(id)}
            />
            <StoryCounter fixture={fixture} />
            <StorySibling fixture={fixture} />
            <output aria-label="Detail request">{detail}</output>
          </>
        )}
        <p>Only Complete evidence is eligible for a performance budget. Incomplete never passes.</p>
        <button type="button" disabled={state._tag === 'Running'} onClick={() => measure(false)}>
          Measure small work
        </button>
        <button type="button" disabled={state._tag === 'Running'} onClick={() => measure(true)}>
          Measure blocking work
        </button>
        <output
          aria-label="Measurement result"
          data-tag={state._tag === 'Measured' ? state.measurement._tag : state._tag}
        >
          {state._tag === 'Measured'
            ? state.measurement._tag === 'Complete'
              ? `Complete — eligible: true; frames: ${state.measurement.data.framesCaptured}; frame drops: ${state.measurement.data.frameDrops}; clicks: ${state.measurement.data.counterDelta['story.clicks'] ?? 0}`
              : `Incomplete — eligible: false; reasons: ${state.measurement.reasons.join(', ')}`
            : state._tag === 'Failed'
              ? state.cause
              : state._tag}
        </output>
      </div>
    </StoryScope>
  )
}

const meta = {
  title: 'meters/PerfGates',
  component: PerfGateView,
  parameters: { layout: 'centered' },
  args: { configured: true },
} satisfies Meta<typeof PerfGateView>
export default meta
type Story = StoryObj<typeof meta>

/** measureWindow brackets actual work and waits for real frame settlement. */
export const MeasuredWindow: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // Read actual calibration rather than sleeping or manufacturing FPS evidence.
    await waitFor(
      () => {
        const frames = fixture.meters.headless.snapshot().frames
        expect(frames._tag === 'Value' && frames.value.calibration._tag !== 'Pending').toBe(true)
      },
      { timeout: 10_000 },
    )
    await userEvent.click(canvas.getByRole('button', { name: 'Measure small work' }))
    await waitFor(
      () =>
        expect(canvas.getByLabelText('Measurement result').getAttribute('data-tag')).toMatch(
          /^(Complete|Incomplete)$/,
        ),
      { timeout: 10_000 },
    )
    const result = canvas.getByLabelText('Measurement result')
    if (result.getAttribute('data-tag') === 'Complete')
      await expect(result).toHaveTextContent('eligible: true')
    else await expect(result).toHaveTextContent('eligible: false')
  },
}

/** No configured frame source yields honest, ineligible evidence. */
export const Unconfigured: Story = {
  args: { configured: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Measure small work' }))
    await waitFor(() =>
      expect(canvas.getByLabelText('Measurement result')).toHaveTextContent(
        'Incomplete — eligible: false; reasons: NotConfigured',
      ),
    )
  },
}

/** Compare a real browser gate and the genuinely unconfigured session. */
export const AllStates: Story = {
  render: () => (
    <div>
      <h2>Configured</h2>
      <PerfGateView configured={true} />
      <h2>Unconfigured</h2>
      <PerfGateView configured={false} />
    </div>
  ),
}

/** Unscripted gate surface; automation drives real interactions through its scoped bridge. */
export const Interactive: Story = {}
