// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from '@effect/vitest'
import { act, cleanup, fireEvent, render, screen, type RenderResult } from '@testing-library/react'
import { Effect, Exit, Scope } from 'effect'
import * as React from 'react'
import { vi } from 'vitest'

import { testCanvas } from '../canvas/_test-canvas.ts'
import { lightMeterTheme, numberBlock } from '../canvas/index.ts'
import { counterToken, makeInstrumentation } from '../instrumentation/index.ts'
import { makeSeries, type NumberValue, type SeriesWriter } from '../series/index.ts'
import { subscribePresentation } from '../series/internal.ts'
import { testPlatform } from '../session/_test-platform.ts'
import { makeMeters, makeSource } from '../session/index.ts'
import {
  MeterStrip,
  MetersProvider,
  reactCommitsSource,
  RenderProfiler,
  useMeters,
  useSeries,
  useSeriesSnapshot,
  type ReactCommit,
} from './index.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const fixture = () => {
  const host = testPlatform()
  const canvas = testCanvas()
  const series = makeSeries<NumberValue>({ id: 'work', label: 'Work', unit: 'count', capacity: 20 })
  let started = 0
  const source = makeSource({
    id: 'work',
    series,
    cadence: { _tag: 'PerFrame' },
    start: ({ sink, clock }) =>
      Effect.gen(function* () {
        started++
        yield* clock.subscribe({
          phase: 'Source',
          listener: (tick) =>
            sink.append({
              sample: {
                _tag: 'Value',
                atMs: tick.atMs,
                value: { _tag: 'Number', value: tick.sequence },
              },
            }),
        })
      }),
  })
  const meters = makeMeters({ sources: [source], platform: host.platform })
  const blocks = [numberBlock({ id: 'work', series })]
  return {
    host,
    canvas,
    meters,
    series,
    blocks,
    get started() {
      return started
    },
  }
}

describe('React meter strip', () => {
  it.effect('renders one canvas at fractional DPR without starting any source or clock', () =>
    Effect.gen(function* () {
      const f = fixture()
      yield* Effect.promise(() =>
        act(async () => {
          render(
            <MeterStrip
              meters={f.meters}
              blocks={f.blocks}
              theme={lightMeterTheme}
              frozen={false}
              onFrozenChange={() => {}}
              onOpenDetail={() => {}}
              platform={f.canvas.platform}
            />,
          )
        }),
      )
      expect(document.querySelectorAll('canvas').length).toBe(1)
      expect(document.querySelector('canvas')?.width).toBe(188)
      expect(f.started).toBe(0)
      expect(f.host.requests).toBe(0)
      expect(screen.getByLabelText('Work').textContent).toBe('n/a (NoSamples)')
    }),
  )
  it.effect('starts accessible names with visible labels and values, including short labels', () =>
    Effect.gen(function* () {
      const f = fixture()
      const blocks = [
        f.blocks[0]!,
        numberBlock({ id: 'short-work', series: f.series, shortLabel: 'Jobs' }),
      ]
      yield* Effect.promise(() =>
        act(async () => {
          render(
            <MetersProvider meters={f.meters}>
              <MeterStrip
                meters={f.meters}
                blocks={blocks}
                theme={lightMeterTheme}
                frozen={false}
                onFrozenChange={() => {}}
                onOpenDetail={() => {}}
                platform={f.canvas.platform}
              />
            </MetersProvider>,
          )
        }),
      )
      act(() => f.host.tick(250))
      act(() => f.host.tick(250))
      const value = screen.getAllByLabelText('Work')[0]!.textContent
      expect(value).not.toContain('n/a')
      const full = screen.getByRole('button', { name: `Work ${value}` })
      const short = screen.getByRole('button', { name: `Jobs ${value}` })
      expect(full.getAttribute('aria-label')?.startsWith(`Work ${value}`)).toBe(true)
      expect(short.getAttribute('aria-label')?.startsWith(`Jobs ${value}`)).toBe(true)
      const fullDescription = full.getAttribute('aria-describedby')!
      const shortDescription = short.getAttribute('aria-describedby')!
      expect(shortDescription).not.toBe(fullDescription)
      expect(document.getElementById(shortDescription)?.textContent).toContain(`Work: ${value}`)
      expect(document.getElementById(shortDescription)?.textContent).toContain('Open meter details')
      expect(screen.queryByRole('tooltip')).toBeNull()
    }),
  )
  it.effect(
    'fills the measured slot, shrinks overlays with the canvas, and keeps freeze compact',
    () =>
      Effect.gen(function* () {
        const f = fixture()
        const blocks = [
          f.blocks[0]!,
          numberBlock({ id: 'work-2', series: f.series }),
          numberBlock({ id: 'work-3', series: f.series }),
        ]
        f.canvas.setAvailableWidth(1200)
        yield* Effect.promise(() =>
          act(async () => {
            render(
              <MeterStrip
                meters={f.meters}
                blocks={blocks}
                theme={lightMeterTheme}
                frozen={false}
                onFrozenChange={() => {}}
                onOpenDetail={() => {}}
                platform={f.canvas.platform}
              />,
            )
          }),
        )
        const widths = () =>
          screen.getAllByRole('button', { name: /^Work / }).map((button) => button.style.width)
        expect(widths()).toEqual(['150px', '150px', '150px'])
        expect(document.querySelector('canvas')?.style.width).toBe('454px')
        act(() => f.canvas.setAvailableWidth(304))
        expect(widths()).toEqual(['100px', '100px', '100px'])
        expect(document.querySelector('canvas')?.style.width).toBe('304px')
        expect(document.querySelector('canvas')?.width).toBe(380)
        const freeze = screen.getByRole('button', { name: 'Freeze meters' })
        expect(freeze.getAttribute('aria-pressed')).toBe('false')
        expect(freeze.textContent).toBe('')
        expect(freeze.style.width).toBe('24px')
        expect(freeze.style.height).toBe('24px')
      }),
  )
  it.effect(
    'shows keyboard tooltips without opening detail; click, Enter, and Space activate the host',
    () =>
      Effect.gen(function* () {
        const f = fixture()
        const selections: { readonly id: string }[] = []
        yield* Effect.promise(() =>
          act(async () => {
            render(
              <MeterStrip
                meters={f.meters}
                blocks={f.blocks}
                theme={lightMeterTheme}
                frozen={false}
                onFrozenChange={() => {}}
                onOpenDetail={(selection) => selections.push(selection)}
                platform={f.canvas.platform}
              />,
            )
          }),
        )
        const meter = screen.getByRole('button', { name: 'Work n/a (NoSamples)' })
        fireEvent.focus(meter)
        expect(screen.getByRole('tooltip').textContent).toBe('Work: n/a (NoSamples)')
        const descriptionId = meter.getAttribute('aria-describedby')!
        expect(descriptionId).not.toBe(screen.getByRole('tooltip').id)
        expect(document.getElementById(descriptionId)?.textContent).toContain(
          'Work: n/a (NoSamples)',
        )
        expect(selections).toEqual([])
        fireEvent.click(meter)
        fireEvent.keyDown(meter, { key: 'Enter' })
        fireEvent.keyDown(meter, { key: ' ' })
        expect(selections).toEqual([{ id: 'work' }, { id: 'work' }, { id: 'work' }])
        fireEvent.keyDown(meter, { key: 'Escape' })
        expect(screen.queryByRole('tooltip')).toBeNull()
        expect(meter.getAttribute('aria-describedby')).toBe(descriptionId)
        expect(document.getElementById(descriptionId)).not.toBeNull()
        fireEvent.blur(meter)
        expect(screen.queryByRole('tooltip')).toBeNull()
      }),
  )
  it.effect(
    'keeps value/text parity and freezes only the selected renderer while another strip stays live',
    () =>
      Effect.gen(function* () {
        const f = fixture()
        const FrozenHost = (): React.ReactNode => {
          const [frozen, setFrozen] = React.useState(false)
          return (
            <>
              <MeterStrip
                meters={f.meters}
                blocks={f.blocks}
                theme={lightMeterTheme}
                frozen={frozen}
                onFrozenChange={setFrozen}
                onOpenDetail={() => {}}
                platform={f.canvas.platform}
              />
              <MeterStrip
                meters={f.meters}
                blocks={f.blocks}
                theme={lightMeterTheme}
                frozen={false}
                onFrozenChange={() => {}}
                onOpenDetail={() => {}}
                platform={f.canvas.platform}
              />
            </>
          )
        }
        yield* Effect.promise(() =>
          act(async () => {
            render(
              <MetersProvider meters={f.meters}>
                <FrozenHost />
              </MetersProvider>,
            )
          }),
        )
        // The first visible frame anchors the 250ms React publication cadence.
        act(() => f.host.tick(250))
        const published = screen.getAllByLabelText('Work')[0]?.textContent
        expect(f.canvas.texts.at(-1)).not.toBe(published)
        act(() => f.host.tick(250))
        const before = screen.getAllByLabelText('Work')[0]?.textContent
        expect(f.canvas.texts.at(-1)).toBe(before)
        expect(f.started).toBe(1)
        fireEvent.click(screen.getAllByRole('button', { name: 'Freeze meters' })[0]!)
        act(() => f.host.tick(250))
        const outputs = screen.getAllByLabelText('Work')
        expect(outputs[0]?.textContent).toBe(before)
        expect(outputs[1]?.textContent).not.toBe(before)
        expect(f.host.pending).toBe(1)
        expect(f.started).toBe(1)
        expect(f.meters.store.read({ series: f.series }).latest?._tag).toBe('Value')
        fireEvent.click(screen.getByRole('button', { name: 'Resume meters' }))
        expect(screen.getAllByLabelText('Work')[0]?.textContent).toBe(
          screen.getAllByLabelText('Work')[1]?.textContent,
        )
      }),
  )
  it.effect('publishes both series hooks at 250ms while raw acquisition stays current', () =>
    Effect.gen(function* () {
      const f = fixture()
      const renders = { sample: 0, snapshot: 0 }
      const SampleOutput = (): React.ReactNode => {
        renders.sample++
        const sample = useSeries(f.series)
        return (
          <output aria-label="Published sample">
            {sample._tag === 'Value' ? sample.value.value : sample.reason}
          </output>
        )
      }
      const SnapshotOutput = (): React.ReactNode => {
        renders.snapshot++
        const snapshot = useSeriesSnapshot(f.series)
        return <output aria-label="Published history">{snapshot.samples.length}</output>
      }
      let mounted: RenderResult | undefined
      yield* Effect.promise(() =>
        act(async () => {
          mounted = render(
            <MetersProvider meters={f.meters}>
              <SampleOutput />
              <SnapshotOutput />
            </MetersProvider>,
          )
        }),
      )
      const initialRenders = { ...renders }
      expect(screen.getByLabelText('Published sample').textContent).toBe('NoSamples')
      expect(screen.getByLabelText('Published history').textContent).toBe('0')
      act(() => f.host.tick(16))
      act(() => f.host.tick(249))
      expect(f.meters.store.read({ series: f.series }).latest).toMatchObject({
        _tag: 'Value',
        value: { value: 2 },
      })
      expect(f.meters.store.snapshotSeries({ series: f.series }).samples).toHaveLength(2)
      expect(renders).toEqual(initialRenders)
      expect(screen.getByLabelText('Published sample').textContent).toBe('NoSamples')
      expect(screen.getByLabelText('Published history').textContent).toBe('0')
      act(() => f.host.tick(1))
      expect(renders).toEqual({
        sample: initialRenders.sample + 1,
        snapshot: initialRenders.snapshot + 1,
      })
      expect(screen.getByLabelText('Published sample').textContent).toBe('3')
      expect(screen.getByLabelText('Published history').textContent).toBe('3')
      const publishedRenders = { ...renders }
      act(() => f.host.tick(16))
      expect(f.meters.store.snapshotSeries({ series: f.series }).samples).toHaveLength(4)
      expect(renders).toEqual(publishedRenders)
      // An unrelated parent render must not expose acquisition ahead of publication.
      act(() =>
        mounted?.rerender(
          <MetersProvider meters={f.meters}>
            <SampleOutput />
            <SnapshotOutput />
          </MetersProvider>,
        ),
      )
      expect(screen.getByLabelText('Published sample').textContent).toBe('3')
      expect(screen.getByLabelText('Published history').textContent).toBe('3')
      const parentRenders = { ...renders }
      act(() => f.host.tick(234))
      expect(renders).toEqual({
        sample: parentRenders.sample + 1,
        snapshot: parentRenders.snapshot + 1,
      })
      expect(screen.getByLabelText('Published sample').textContent).toBe('5')
      expect(screen.getByLabelText('Published history').textContent).toBe('5')
      yield* Effect.promise(() => act(async () => cleanup()))
      expect(f.host.pending).toBe(0)
    }),
  )
  it.effect(
    'publishes event series without frames and pauses the timer while hidden or stopped',
    () =>
      Effect.gen(function* () {
        let stopPublication: (() => void) | undefined
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await act(async () => cleanup())
            stopPublication?.()
            vi.useRealTimers()
          }),
        )
        const host = testPlatform()
        const series = makeSeries<NumberValue>({
          id: 'events',
          label: 'Events',
          unit: 'count',
          capacity: 20,
        })
        let writer: SeriesWriter<NumberValue> | undefined
        const source = makeSource({
          id: 'events',
          series,
          cadence: { _tag: 'Event' },
          start: ({ sink }) =>
            Effect.sync(() => {
              writer = sink
            }),
        })
        const meters = makeMeters({
          sources: [source],
          platform: { ...host.platform, supportsFrames: () => false },
        })
        const Output = (): React.ReactNode => {
          const sample = useSeries(series)
          const snapshot = useSeriesSnapshot(series)
          return (
            <>
              <output aria-label="Event sample">
                {sample._tag === 'Value' ? sample.value.value : sample.reason}
              </output>
              <output aria-label="Event history">{snapshot.samples.length}</output>
            </>
          )
        }
        yield* Effect.promise(() =>
          act(async () => {
            render(
              <MetersProvider meters={meters}>
                <Output />
              </MetersProvider>,
            )
          }),
        )
        expect(writer).toBeDefined()
        expect(host.requests).toBe(0)
        expect(vi.getTimerCount()).toBe(1)
        act(() =>
          writer?.append({
            sample: {
              _tag: 'Value',
              atMs: host.platform.now(),
              value: { _tag: 'Number', value: 1 },
            },
          }),
        )
        expect(meters.store.read({ series }).latest).toMatchObject({ value: { value: 1 } })
        act(() => vi.advanceTimersByTime(249))
        expect(screen.getByLabelText('Event sample').textContent).toBe('NoSamples')
        expect(screen.getByLabelText('Event history').textContent).toBe('0')
        act(() => vi.advanceTimersByTime(1))
        expect(screen.getByLabelText('Event sample').textContent).toBe('1')
        expect(screen.getByLabelText('Event history').textContent).toBe('1')
        act(() => host.setVisible(false))
        expect(vi.getTimerCount()).toBe(0)
        act(() =>
          writer?.append({
            sample: {
              _tag: 'Value',
              atMs: host.platform.now(),
              value: { _tag: 'Number', value: 2 },
            },
          }),
        )
        act(() => vi.advanceTimersByTime(1000))
        expect(screen.getByLabelText('Event sample').textContent).toBe('1')
        act(() => host.setVisible(true))
        expect(vi.getTimerCount()).toBe(1)
        act(() =>
          writer?.append({
            sample: {
              _tag: 'Value',
              atMs: host.platform.now(),
              value: { _tag: 'Number', value: 3 },
            },
          }),
        )
        act(() => vi.advanceTimersByTime(249))
        expect(screen.getByLabelText('Event sample').textContent).toBe('2')
        act(() => vi.advanceTimersByTime(1))
        expect(screen.getByLabelText('Event sample').textContent).toBe('3')
        const notify = vi.fn()
        stopPublication = meters.store[subscribePresentation](notify)
        yield* Effect.promise(() => act(async () => cleanup()))
        expect(vi.getTimerCount()).toBe(0)
        expect(host.observers).toBe(0)
        const stoppedNotifications = notify.mock.calls.length
        act(() => vi.advanceTimersByTime(1000))
        expect(notify).toHaveBeenCalledTimes(stoppedNotifications)
        expect(host.requests).toBe(0)
      }),
  )
  it.effect(
    'exposes the same session through hooks and releases the provider lease on unmount',
    () =>
      Effect.gen(function* () {
        const f = fixture()
        let sameSession = false
        const Output = (): React.ReactNode => {
          sameSession = useMeters() === f.meters
          const sample = useSeries(f.series)
          return (
            <output aria-label="Hook value">
              {sample._tag === 'Value'
                ? sample.value.value
                : sample._tag === 'Unavailable'
                  ? sample.reason
                  : sample.reason}
            </output>
          )
        }
        yield* Effect.promise(() =>
          act(async () => {
            render(
              <MetersProvider meters={f.meters}>
                <Output />
              </MetersProvider>,
            )
          }),
        )
        expect(sameSession).toBe(true)
        expect(screen.getByLabelText('Hook value').textContent).toBe('NoSamples')
        act(() => f.host.tick(250))
        expect(screen.getByLabelText('Hook value').textContent).toBe('NoSamples')
        act(() => f.host.tick(250))
        expect(screen.getByLabelText('Hook value').textContent).not.toBe('NoSamples')
        yield* Effect.promise(() => act(async () => cleanup()))
        expect(f.host.pending).toBe(0)
      }),
  )
})

describe('actual React Profiler commit source', () => {
  it.effect(
    'publishes callbacks without an onCommit fan-out and records the exact same cumulative counter',
    () =>
      Effect.gen(function* () {
        const host = testPlatform()
        const token = counterToken({ id: 'commits' })
        const instrumentation = makeInstrumentation({ counters: [token], gauges: [] })
        const series = makeSeries<ReactCommit>({
          id: 'commits',
          label: 'Commits',
          unit: 'count',
          capacity: 20,
        })
        const source = reactCommitsSource({ id: 'react', series, instrumentation, counter: token })
        const meters = makeMeters({ sources: [source], platform: host.platform })
        const lease = yield* Scope.make()
        yield* Scope.provide(meters.start, lease)
        expect(meters.store.read({ series }).latest).toMatchObject({
          _tag: 'Unavailable',
          reason: 'NotConfigured',
        })
        let mounted: RenderResult | undefined
        yield* Effect.promise(() =>
          act(async () => {
            mounted = render(
              <RenderProfiler instrumentation={instrumentation} counter={token} id="host">
                <span>First</span>
              </RenderProfiler>,
            )
          }),
        )
        const first = instrumentation.counter({ token }).read()
        expect(first).toBeGreaterThan(0)
        expect(meters.store.read({ series }).latest).toMatchObject({
          _tag: 'Value',
          value: { _tag: 'ReactCommit', id: 'host', commits: first },
        })
        expect(meters.headless.snapshot().counters.commits).toBe(first)
        yield* Effect.promise(() =>
          act(async () => {
            mounted?.rerender(
              <RenderProfiler instrumentation={instrumentation} counter={token} id="host">
                <span>Second</span>
              </RenderProfiler>,
            )
          }),
        )
        expect(instrumentation.counter({ token }).read()).toBe(first + 1)
        yield* Effect.promise(() => act(async () => mounted?.unmount()))
        expect(meters.store.read({ series }).latest).toMatchObject({
          _tag: 'Unavailable',
          reason: 'NotConfigured',
        })
        expect(instrumentation.counter({ token }).read()).toBe(first + 1)
        yield* Scope.close(lease, Exit.void)
      }),
  )
})
