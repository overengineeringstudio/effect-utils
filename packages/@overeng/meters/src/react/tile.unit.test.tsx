// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from '@effect/vitest'
import { act, cleanup, fireEvent, render, screen, type RenderResult } from '@testing-library/react'
import { Effect } from 'effect'
import * as React from 'react'
import { vi } from 'vitest'

import { testCanvas } from '../canvas/_test-canvas.ts'
import {
  freezeMeters,
  lightMeterTheme,
  tileBlock,
  type BlockEvidence,
  type MeterFreeze,
} from '../canvas/index.ts'
import { makeSeries, type NumberValue } from '../series/index.ts'
import { testPlatform } from '../session/_test-platform.ts'
import { makeMeters, makeSource } from '../session/index.ts'
import { MeterEvidence, MeterFreezeButton, MeterTile, MetersProvider } from './index.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const fixture = () => {
  const host = testPlatform()
  const canvas = testCanvas()
  const series = makeSeries<NumberValue>({
    id: 'work',
    label: 'Work',
    unit: 'count',
    capacity: 400,
  })
  const source = makeSource({
    id: 'work',
    series,
    cadence: { _tag: 'PerFrame' },
    start: ({ sink, clock }) =>
      clock.subscribe({
        phase: 'Source',
        listener: (tick) =>
          sink.append({
            sample: {
              _tag: 'Value',
              atMs: tick.atMs,
              value: { _tag: 'Number', value: tick.sequence % 7 },
            },
          }),
      }),
  })
  const meters = makeMeters({ sources: [source], platform: host.platform })
  const block = tileBlock({
    id: 'work',
    series,
    shortLabel: 'work',
    widthPx: 64,
    aggregation: { _tag: 'Bucket', mode: 'Gauge', bucketMs: 250, buckets: 8, unit: 'count' },
    value: (value) => value.value,
  })
  const view = (options: { readonly frozen?: MeterFreeze; readonly onCommit?: () => void }) => (
    <React.Profiler id="tile" onRender={() => options.onCommit?.()}>
      <MetersProvider meters={meters}>
        <MeterTile
          meters={meters}
          block={block}
          theme={lightMeterTheme}
          frozen={options.frozen}
          heightPx={30}
          platform={canvas.platform}
        />
      </MetersProvider>
    </React.Profiler>
  )
  let rendered: RenderResult | undefined
  return {
    host,
    canvas,
    meters,
    block,
    /** Mount once, or re-render the same provider so the session keeps running. */
    mount: (options: { readonly frozen?: MeterFreeze; readonly onCommit?: () => void } = {}) =>
      Effect.promise(() =>
        act(async () => {
          if (rendered === undefined) rendered = render(view(options))
          else rendered.rerender(view(options))
        }),
      ),
    ticks: (count: number) =>
      act(() => {
        for (let index = 0; index < count; index++) host.tick()
      }),
  }
}

const evidence = (overrides: Partial<BlockEvidence> = {}): BlockEvidence => ({
  label: 'Work',
  unit: 'count',
  text: '4',
  evaluatedAtMs: 10_000,
  revision: 7,
  latest: { _tag: 'Value', atMs: 8_500 },
  retention: {
    capacity: 10,
    length: 3,
    oldestAtMs: 7_000,
    newestAtMs: 8_500,
    overflowCount: 0,
    firstRetainedSequence: 0,
    nextSequence: 3,
  },
  aggregation: {
    _tag: 'Bucket',
    mode: 'Gauge',
    bucketMs: 250,
    buckets: 8,
    unit: 'count',
    endMs: 10_000,
  },
  range: { windowMs: 2_000, endMs: 10_000, minimum: 1, maximum: 4 },
  ...overrides,
})

/** Snapshot wording is anchored to the evaluation instant, never to a live clock. */
const liveWords = /\bago\b|\bnow\b|\bcurrent/i

describe('MeterEvidence', () => {
  it('renders one captured snapshot with evaluation-relative ages and the reduced range', () => {
    const props = {
      id: 'card',
      evidence: evidence(),
      trigger: 'Refresh',
      frozen: false,
      theme: lightMeterTheme,
    } as const
    const { container, rerender } = render(<MeterEvidence {...props} />)
    const card = screen.getByRole('tooltip')
    expect(card.id).toBe('card')
    expect(Array.from(card.children, (line) => line.textContent)).toEqual([
      'Work 4',
      'latest sample 1.5 s before evaluation',
      'range over 2.0 s ending 0.0 s before evaluation: min 1 / max 4',
      'evaluated at session clock 10.0 s · revision 7',
      'Snapshot refreshed · R refreshes',
    ])
    expect(card.textContent).not.toMatch(liveWords)
    // Pure: identical props render identical markup.
    const first = container.innerHTML
    rerender(<MeterEvidence {...props} />)
    expect(container.innerHTML).toBe(first)
  })

  it('dates the range by its completed window end, not the evaluation instant', () => {
    const bucket = {
      _tag: 'Bucket',
      mode: 'Gauge',
      bucketMs: 1_000,
      buckets: 30,
      unit: 'count',
    } as const
    const lineOf = (overrides: Partial<BlockEvidence>) => {
      const { unmount } = render(
        <MeterEvidence
          id="range"
          evidence={evidence({ evaluatedAtMs: 10_900, ...overrides })}
          trigger="Focus"
          frozen={false}
          theme={lightMeterTheme}
        />,
      )
      const line = screen.getByRole('tooltip').children[2]?.textContent
      unmount()
      return line
    }
    expect(
      lineOf({
        aggregation: { ...bucket, endMs: 10_000 },
        range: { windowMs: 30_000, endMs: 10_000, minimum: 2, maximum: 9 },
      }),
    ).toBe('range over 30.0 s ending 0.9 s before evaluation: min 2 / max 9')
    // An empty window derives its end from the aggregation's completed end.
    expect(lineOf({ aggregation: { ...bucket, endMs: 10_000 }, range: undefined })).toBe(
      'range over 30.0 s ending 0.9 s before evaluation: no values',
    )
  })

  it('names the unavailable reason and an empty window instead of a value', () => {
    render(
      <MeterEvidence
        id="card"
        evidence={evidence({ text: 'n/a (NoSamples)', latest: undefined, range: undefined })}
        trigger="Focus"
        frozen
        theme={lightMeterTheme}
      />,
    )
    const lines = Array.from(screen.getByRole('tooltip').children, (line) => line.textContent)
    expect(lines).toEqual([
      'Work n/a (NoSamples)',
      'no sample before evaluation',
      'range over 2.0 s ending 0.0 s before evaluation: no values',
      'evaluated at session clock 10.0 s (frozen) · revision 7',
      'Snapshot taken on focus · R refreshes',
    ])
    render(
      <MeterEvidence
        id="gap"
        evidence={evidence({
          text: 'n/a (Hidden gap)',
          latest: { _tag: 'Gap', atMs: 9_000, durationMs: 400, reason: 'Hidden' },
        })}
        trigger="Hover"
        frozen={false}
        theme={lightMeterTheme}
      />,
    )
    expect(document.getElementById('gap')?.textContent).toContain(
      'gap (Hidden, 0.4 s) ending 1.0 s before evaluation',
    )
  })

  it('dates a stale source by its last real sample, relative to evaluation', () => {
    render(
      <MeterEvidence
        id="stale"
        evidence={evidence({
          text: 'n/a (Stale; last known 4 at 6500ms)',
          latest: { _tag: 'Unavailable', atMs: 9_500, reason: 'Stale', lastKnownAtMs: 6_500 },
        })}
        trigger="Refresh"
        frozen={false}
        theme={lightMeterTheme}
      />,
    )
    const text = document.getElementById('stale')?.textContent ?? ''
    expect(text).toContain(
      'unavailable (Stale) 0.5 s before evaluation; last sample 3.5 s before evaluation',
    )
    expect(text).not.toMatch(/\bago\b|\bnow\b|\bcurrent\b/)
  })
})

describe('MeterTile', () => {
  it.effect('draws every frame on the shared clock without React commits or DOM writes', () =>
    Effect.gen(function* () {
      const f = fixture()
      let commits = 0
      yield* f.mount({ onCommit: () => commits++ })
      f.ticks(2)
      const tile = screen.getByRole('button', { name: 'work' })
      const markup = document.body.innerHTML
      const committed = commits
      const drawn = f.canvas.texts.length
      const samples = 120
      f.ticks(samples)
      // Every frame drew the label and the value on the canvas …
      expect(f.canvas.texts.length - drawn).toBe(samples * 2)
      expect(f.canvas.texts.at(-2)).toBe('work')
      // … while React committed nothing and the DOM stayed byte-identical.
      expect(commits).toBe(committed)
      expect(document.body.innerHTML).toBe(markup)
      expect(document.querySelectorAll('canvas')).toHaveLength(1)
      expect(tile.textContent).toBe('')
    }),
  )

  it.effect('keeps a static name and title equal to the meter name, never a value', () =>
    Effect.gen(function* () {
      const f = fixture()
      yield* f.mount()
      for (let round = 0; round < 5; round++) {
        f.ticks(30)
        const tile = screen.getByRole('button', { name: 'work' })
        expect(tile.getAttribute('aria-label')).toBe('work')
        expect(tile.getAttribute('title')).toBe('Work')
      }
    }),
  )

  it.effect('captures on focus, refreshes on R and activation, and dismisses on Escape', () =>
    Effect.gen(function* () {
      const f = fixture()
      yield* f.mount()
      f.ticks(30)
      const tile = screen.getByRole('button', { name: 'work' })
      expect(screen.queryByRole('tooltip')).toBeNull()
      act(() => tile.focus())
      const card = screen.getByRole('tooltip')
      expect(tile.getAttribute('aria-describedby')).toBe(card.id)
      expect(card.textContent).toContain('Snapshot taken on focus')
      const focused = card.textContent
      // The card is a snapshot: later samples do not change it.
      f.ticks(30)
      expect(screen.getByRole('tooltip').textContent).toBe(focused)
      fireEvent.keyDown(tile, { key: 'r' })
      const refreshed = screen.getByRole('tooltip').textContent
      expect(refreshed).toContain('Snapshot refreshed')
      expect(refreshed).toContain(
        `evaluated at session clock ${(f.meters.clock.now() / 1000).toFixed(1)} s`,
      )
      expect(refreshed).not.toBe(focused)
      // Native buttons turn Enter and Space into click; activation is the explicit refresh.
      fireEvent.click(tile)
      expect(screen.getByRole('tooltip').textContent).toContain('Snapshot taken on activation')
      fireEvent.keyDown(tile, { key: 'Escape' })
      expect(screen.queryByRole('tooltip')).toBeNull()
      expect(tile.hasAttribute('aria-describedby')).toBe(false)
      act(() => tile.blur())
      fireEvent.mouseEnter(tile)
      expect(screen.getByRole('tooltip').textContent).toContain('Snapshot taken on hover')
      fireEvent.mouseLeave(tile)
      expect(screen.queryByRole('tooltip')).toBeNull()
    }),
  )

  it.effect('reads one shared frozen snapshot in the canvas and the card', () =>
    Effect.gen(function* () {
      const f = fixture()
      yield* f.mount()
      f.ticks(60)
      const freeze = freezeMeters({ meters: f.meters, blocks: [f.block] })
      yield* f.mount({ frozen: freeze })
      f.ticks(1)
      const frozenPair = f.canvas.texts.slice(-2)
      f.ticks(60)
      // Sources keep sampling, but the frozen canvas keeps drawing the same snapshot.
      expect(f.canvas.texts.slice(-2)).toEqual(frozenPair)
      expect(f.meters.clock.now()).toBeGreaterThan(freeze.atMs)
      const tile = screen.getByRole('button', { name: 'work' })
      act(() => tile.focus())
      const frozenAt = `evaluated at session clock ${(freeze.atMs / 1000).toFixed(1)} s (frozen)`
      expect(screen.getByRole('tooltip').textContent).toContain(frozenAt)
      expect(screen.getByRole('tooltip').textContent).toContain(`Work ${frozenPair[1]}`)
      f.ticks(60)
      fireEvent.keyDown(tile, { key: 'R' })
      expect(screen.getByRole('tooltip').textContent).toContain(frozenAt)
      // Unfreezing replaces the view and drops the frozen card.
      yield* f.mount()
      expect(screen.queryByRole('tooltip')).toBeNull()
    }),
  )
})

describe('MeterFreezeButton', () => {
  it('keeps one accessible name and reports state through aria-pressed', () => {
    const { rerender } = render(
      <MeterFreezeButton frozenAtMs={undefined} onToggle={() => {}} theme={lightMeterTheme} />,
    )
    const button = screen.getByRole('button', { name: 'Freeze meters' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.textContent).toBe('freeze')
    rerender(
      <MeterFreezeButton frozenAtMs={12_340} onToggle={() => {}} theme={lightMeterTheme} compact />,
    )
    expect(screen.getByRole('button', { name: 'Freeze meters' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    // Icon only below the host's breakpoint; the name stays.
    expect(button.textContent).toBe('')
    expect(button.getAttribute('title')).toBe('Frozen at session clock 12.3 s')
  })
})
