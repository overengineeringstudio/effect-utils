// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from '@effect/vitest'
import { act, cleanup, fireEvent, render, screen, type RenderResult } from '@testing-library/react'
import { Effect, Exit, Scope } from 'effect'
import * as React from 'react'
import { vi } from 'vitest'

import { testCanvas } from '../canvas/_test-canvas.ts'
import { lightMeterTheme, numberBlock } from '../canvas/index.ts'
import { counterToken, makeInstrumentation } from '../instrumentation/index.ts'
import { makeSeries, type NumberValue } from '../series/index.ts'
import { testPlatform } from '../session/_test-platform.ts'
import { makeMeters, makeSource } from '../session/index.ts'
import {
  MeterStrip,
  MetersProvider,
  reactCommitsSource,
  RenderProfiler,
  useMeters,
  useSeries,
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
          screen.getAllByRole('button', { name: /^Work:/ }).map((button) => button.style.width)
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
        const meter = screen.getByRole('button', { name: 'Work: n/a (NoSamples)' })
        fireEvent.focus(meter)
        expect(screen.getByRole('tooltip').textContent).toBe('Work: n/a (NoSamples)')
        expect(meter.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
        expect(selections).toEqual([])
        fireEvent.click(meter)
        fireEvent.keyDown(meter, { key: 'Enter' })
        fireEvent.keyDown(meter, { key: ' ' })
        expect(selections).toEqual([{ id: 'work' }, { id: 'work' }, { id: 'work' }])
        fireEvent.keyDown(meter, { key: 'Escape' })
        expect(screen.queryByRole('tooltip')).toBeNull()
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
