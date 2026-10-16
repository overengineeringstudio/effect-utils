// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'
import { vi } from 'vitest'

import { makeSeries, makeSeriesStore, type NumberValue } from '../series/index.ts'
import { testPlatform } from '../session/_test-platform.ts'
import type { FpsValue } from '../session/frame.ts'
import { makeMeters, makeSource } from '../session/index.ts'
import { testCanvas } from './_test-canvas.ts'
import {
  counterBlock,
  formatMeterValue,
  formatRange,
  frameBlock,
  layoutStrip,
  lightMeterTheme,
  makeCanvasStrip,
  makeStripView,
  numberBlock,
  plotRange,
  resolveMeterTheme,
} from './index.ts'

afterEach(() => vi.restoreAllMocks())

const fixture = () => {
  const host = testPlatform()
  const surface = testCanvas()
  const series = makeSeries<NumberValue>({
    id: 'count',
    label: 'Count',
    unit: 'count',
    capacity: 20,
  })
  let started = 0
  const source = makeSource({
    id: 'count',
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
  const blocks = [numberBlock({ id: 'count', series })]
  return {
    host,
    surface,
    series,
    meters,
    blocks,
    get started() {
      return started
    },
  }
}

describe('canvas strip', () => {
  it('describes the shared stale evidence without treating last-known values as live', () => {
    const series = makeSeries<NumberValue>({
      id: 'stale',
      label: 'Stale',
      unit: 'count',
      capacity: 4,
    })
    const store = makeSeriesStore()
    const sink = store.register({ series })
    const reader = numberBlock({ id: 'stale', series }).read(store)
    sink.append({ sample: { _tag: 'Value', atMs: 0, value: { _tag: 'Number', value: 4 } } })
    expect(reader.describe()).toBe('4')
    sink.append({
      sample: {
        _tag: 'Unavailable',
        atMs: 100,
        reason: 'Stale',
        lastKnown: { atMs: 0, value: { _tag: 'Number', value: 4 } },
      },
    })
    expect(reader.describe()).toBe('n/a (Stale; last known 4 at 0ms)')
    expect(reader.snapshot().describe()).toBe(reader.describe())
    expect(store.read({ series }).latest?._tag).toBe('Unavailable')
  })

  it('ranges completed event and counter bins, including plotted empty zero bins', () => {
    const surface = testCanvas()
    const ctx = surface.canvas.getContext('2d')
    if (ctx === null) throw new TypeError('Injected canvas context is required')
    for (const { mode, atMs } of [
      { mode: 'Event', atMs: 51 },
      { mode: 'Counter', atMs: 51 },
      { mode: 'Event', atMs: 95 },
      { mode: 'Counter', atMs: 95 },
    ] as const) {
      const series = makeSeries<NumberValue>({ id: mode, label: mode, unit: 'count', capacity: 4 })
      const store = makeSeriesStore()
      const writer = store.register({ series })
      if (mode === 'Counter')
        writer.append({ sample: { _tag: 'Value', atMs: 1, value: { _tag: 'Number', value: 0 } } })
      writer.append({ sample: { _tag: 'Value', atMs, value: { _tag: 'Number', value: 20 } } })
      writer.append({
        sample: {
          _tag: 'Value',
          atMs: atMs + 4,
          value: { _tag: 'Number', value: mode === 'Counter' ? 50 : 30 },
        },
      })
      const history = mode === 'Counter' || atMs === 51 ? [0, 50] : [50]
      const range = plotRange({ history, nominalMax: 100, mode: 'auto' })
      surface.rectangles.length = 0
      numberBlock({ id: mode, series, mode, range: 'auto', nominalMax: 100, marks: [55] })
        .read(store)
        .draw({
          ctx,
          rect: { x: 0, y: 0, width: 16, height: 32 },
          nowMs: 100,
          historyMs: 100,
          theme: lightMeterTheme,
        })
      const mark = surface.rectangles.find((rect) => rect[2] === 8 && rect[3] === 1)
      expect(mark?.[1]).toBeCloseTo(18 + 12 * ((range.hi - 55) / (range.hi - range.lo)))
      const bar = surface.rectangles.find(
        (rect) => rect[0] === (atMs === 51 ? 8 : 11) && rect[2] === 1,
      )
      expect(bar?.[3]).toBeCloseTo(12 * ((50 - range.lo) / (range.hi - range.lo)))
    }
  })
  it('uses signed completed event totals rather than transient peaks for fixed ranges', () => {
    const surface = testCanvas()
    const ctx = surface.canvas.getContext('2d')
    if (ctx === null) throw new TypeError('Injected canvas context is required')
    const series = makeSeries<NumberValue>({
      id: 'signed-events',
      label: 'Events',
      unit: 'count',
      capacity: 4,
    })
    const store = makeSeriesStore()
    const writer = store.register({ series })
    writer.append({ sample: { _tag: 'Value', atMs: 51, value: { _tag: 'Number', value: 100 } } })
    writer.append({ sample: { _tag: 'Value', atMs: 55, value: { _tag: 'Number', value: -80 } } })
    numberBlock({
      id: 'signed-events',
      series,
      mode: 'Event',
      range: 'fixed',
      nominalMax: 1,
      marks: [20],
    })
      .read(store)
      .draw({
        ctx,
        rect: { x: 0, y: 0, width: 16, height: 32 },
        nowMs: 100,
        historyMs: 100,
        theme: lightMeterTheme,
      })
    expect(surface.rectangles).toContainEqual([8, 18, 1, 12])
    expect(surface.rectangles).toContainEqual([4, 18, 8, 1])
  })
  it('keeps adjacent subnormal extrema inside an increasing auto range and draws their marks', () => {
    const m = Number.MIN_VALUE
    const range = plotRange({ history: [2 * m, 3 * m], nominalMax: m, mode: 'auto' })
    expect(Number.isFinite(range.lo) && Number.isFinite(range.hi)).toBe(true)
    expect(range.lo).toBeLessThanOrEqual(2 * m)
    expect(range.hi).toBeGreaterThanOrEqual(3 * m)
    expect(range.lo).toBeLessThan(range.hi)
    const surface = testCanvas()
    const ctx = surface.canvas.getContext('2d')
    if (ctx === null) throw new TypeError('Injected canvas context is required')
    const series = makeSeries<NumberValue>({
      id: 'subnormal',
      label: 'Tiny',
      unit: 'count',
      capacity: 4,
    })
    const store = makeSeriesStore()
    const writer = store.register({ series })
    writer.append({ sample: { _tag: 'Value', atMs: 0, value: { _tag: 'Number', value: 2 * m } } })
    writer.append({ sample: { _tag: 'Value', atMs: 1, value: { _tag: 'Number', value: 3 * m } } })
    numberBlock({ id: 'subnormal', series, range: 'auto', nominalMax: m, marks: [2 * m] })
      .read(store)
      .draw({
        ctx,
        rect: { x: 0, y: 0, width: 16, height: 32 },
        nowMs: 100,
        historyMs: 100,
        theme: lightMeterTheme,
      })
    expect(surface.rectangles).toContainEqual([4, 29, 8, 1])
    expect(surface.rectangles.every((rect) => rect.every(Number.isFinite))).toBe(true)
  })
  it('draws finite coordinates for extreme values, clipped custom bounds and tiny scales', () => {
    const surface = testCanvas()
    const ctx = surface.canvas.getContext('2d')
    if (ctx === null) throw new TypeError('Injected canvas context is required')
    const series = makeSeries<NumberValue>({
      id: 'extreme',
      label: 'Extreme',
      unit: 'count',
      capacity: 4,
    })
    const store = makeSeriesStore()
    const writer = store.register({ series })
    writer.append({
      sample: { _tag: 'Value', atMs: 0, value: { _tag: 'Number', value: -Number.MAX_VALUE } },
    })
    writer.append({
      sample: { _tag: 'Value', atMs: 50, value: { _tag: 'Number', value: Number.MAX_VALUE } },
    })
    for (const range of ['auto', { lo: Number.MIN_VALUE, hi: Number.MIN_VALUE * 2 }] as const) {
      surface.rectangles.length = 0
      numberBlock({ id: 'extreme', series, range, marks: [0] })
        .read(store)
        .draw({
          ctx,
          rect: { x: 0, y: 0, width: 16, height: 32 },
          nowMs: 100,
          historyMs: 100,
          theme: lightMeterTheme,
        })
      expect(surface.rectangles.every((rect) => rect.every(Number.isFinite))).toBe(true)
      expect(surface.rectangles.some((rect) => rect[2] === 1 && Math.abs(rect[3] ?? 0) > 0)).toBe(
        true,
      )
    }
    const tiny = plotRange({
      history: [0],
      nominalMax: Number.MIN_VALUE,
      minSpanRatio: Number.MIN_VALUE,
      mode: 'auto',
    })
    expect(tiny).toEqual({ lo: 0, hi: Number.MIN_VALUE })
  })
  it('shares whole-unit fixed bounds and padded auto bounds without inventing missing samples', () => {
    expect(plotRange({ history: [undefined, 301.06], nominalMax: 256, mode: 'fixed' })).toEqual({
      lo: 0,
      hi: 302,
    })
    for (const history of [[], [undefined], [NaN, Infinity, -Infinity]]) {
      expect(plotRange({ history, nominalMax: 10.2, mode: 'auto' })).toEqual({ lo: 0, hi: 11 })
    }
    const constant = plotRange({ history: [50, 50], nominalMax: 100, mode: 'auto' })
    expect(constant.lo).toBeCloseTo(44.25)
    expect(constant.hi).toBeCloseTo(55.75)
    expect(plotRange({ history: [0], nominalMax: 100, mode: 'auto' })).toEqual({ lo: 0, hi: 11.5 })
    const customSpan = plotRange({
      history: [50],
      nominalMax: 100,
      minSpanRatio: 0.2,
      mode: 'auto',
    })
    expect(customSpan.hi - customSpan.lo).toBeCloseTo(23)
  })
  it('retains negative and mixed-sign extrema and bounds finite arithmetic overflow', () => {
    expect(plotRange({ history: [-8, 3], nominalMax: 10, mode: 'fixed' })).toEqual({
      lo: -8,
      hi: 10,
    })
    for (const history of [
      [-8, -2],
      [-8, 3],
      [-Number.MAX_VALUE, Number.MAX_VALUE],
      [Number.MAX_VALUE],
      [-Number.MAX_VALUE],
    ]) {
      const range = plotRange({ history, nominalMax: 10, mode: 'auto' })
      expect(Number.isFinite(range.lo) && Number.isFinite(range.hi)).toBe(true)
      expect(range.lo).toBeLessThan(range.hi)
      expect(range.lo).toBeLessThanOrEqual(Math.min(...history))
      expect(range.hi).toBeGreaterThanOrEqual(Math.max(...history))
    }
    expect(plotRange({ history: [NaN, 5, Infinity], nominalMax: 10, mode: 'fixed' })).toEqual({
      lo: 0,
      hi: 10,
    })
  })
  it('validates caller scales and formats range endpoints with meter units', () => {
    for (const nominalMax of [0, -1, NaN, Infinity]) {
      expect(() => plotRange({ history: [], nominalMax, mode: 'fixed' })).toThrow(TypeError)
    }
    for (const minSpanRatio of [0, -1, NaN, Infinity]) {
      expect(() => plotRange({ history: [], nominalMax: 1, minSpanRatio, mode: 'auto' })).toThrow(
        TypeError,
      )
    }
    expect(formatRange({ range: { lo: 0, hi: 302 }, unit: 'ms' })).toBe('0 ms–302 ms')
    expect(formatRange({ range: { lo: 0, hi: 1024 }, unit: 'bytes' })).toBe('0 B–1.0 KiB')
    expect(formatRange({ range: { lo: -1, hi: 2 }, unit: 'count' })).toBe('-1–2')
    expect(() => formatRange({ range: { lo: 2, hi: 2 }, unit: 'ms' })).toThrow(TypeError)
  })
  it('draws fixed, auto and custom domains and visible marks in the same coordinates as their captions', () => {
    const surface = testCanvas()
    const ctx = surface.canvas.getContext('2d')
    if (ctx === null) throw new TypeError('Injected canvas context is required')
    const series = makeSeries<NumberValue>({ id: 'range', label: 'Range', unit: 'ms', capacity: 4 })
    const store = makeSeriesStore()
    const writer = store.register({ series })
    writer.append({ sample: { _tag: 'Value', atMs: 0, value: { _tag: 'Number', value: 40 } } })
    writer.append({ sample: { _tag: 'Value', atMs: 1, value: { _tag: 'Number', value: 50 } } })
    for (const mode of ['fixed', 'auto', 'custom'] as const) {
      const range =
        mode === 'custom'
          ? { lo: 25, hi: 75 }
          : plotRange({ history: [40, 50], nominalMax: 100, mode })
      const reader = numberBlock({
        id: mode,
        series,
        nominalMax: 100,
        range: mode === 'custom' ? range : mode,
        marks: [range.lo, 50, range.hi, NaN, Infinity, -100, 1000],
      }).read(store)
      surface.rectangles.length = 0
      reader.draw({
        ctx,
        rect: { x: 0, y: 0, width: 16, height: 32 },
        nowMs: 100,
        historyMs: 100,
        theme: lightMeterTheme,
      })
      const mark = surface.rectangles.filter((rect) => rect[2] === 8 && rect[3] === 1)
      expect(mark).toHaveLength(3)
      expect(mark[0]).toEqual([4, 29, 8, 1])
      expect(mark[1]?.[1]).toBeCloseTo(18 + 12 * ((range.hi - 50) / (range.hi - range.lo)))
      expect(mark[2]).toEqual([4, 18, 8, 1])
      const bar = surface.rectangles.find((rect) => rect[0] === 11 && rect[2] === 1)
      expect(bar?.[1]).toBeCloseTo(18 + 12 * ((range.hi - 50) / (range.hi - range.lo)))
      expect(bar?.[3]).toBeCloseTo(12 * ((50 - Math.max(0, range.lo)) / (range.hi - range.lo)))
      expect(formatRange({ range, unit: 'ms' })).toBe(
        `${formatMeterValue({ value: range.lo, unit: 'ms' })}–${formatMeterValue({ value: range.hi, unit: 'ms' })}`,
      )
      expect(reader.describe()).toBe('50 ms')
    }
    for (const range of [
      { lo: 1, hi: 1 },
      { lo: 2, hi: 1 },
      { lo: NaN, hi: 1 },
      { lo: 0, hi: Infinity },
    ]) {
      expect(() => numberBlock({ id: 'invalid', series, range })).toThrow(TypeError)
    }
  })
  it('lays out variable widths and fractional backing dimensions without a trailing gap', () => {
    expect(layoutStrip({ widths: [150, 151], heightPx: 32, gapPx: 2, dpr: 1.25 })).toEqual({
      widthPx: 303,
      heightPx: 32,
      dpr: 1.25,
      backingWidth: 379,
      backingHeight: 40,
      rects: [
        { x: 0, y: 0, width: 150, height: 32 },
        { x: 152, y: 0, width: 151, height: 32 },
      ],
    })
    expect(layoutStrip({ widths: [], heightPx: 32, gapPx: 2, dpr: 1.5 }).widthPx).toBe(0)
  })
  it.effect('attaches only drawing, sizes at actual DPR, and releases resize observers', () =>
    Effect.gen(function* () {
      const f = fixture()
      const scope = yield* Scope.make()
      yield* Scope.provide(
        makeCanvasStrip({
          canvas: f.surface.canvas,
          meters: f.meters,
          blocks: f.blocks,
          platform: f.surface.platform,
          readTheme: () => lightMeterTheme,
        }).attach,
        scope,
      )
      expect(f.started).toBe(0)
      expect(f.host.requests).toBe(0)
      expect(f.host.observers).toBe(0)
      expect(f.surface.canvas.width).toBe(188)
      expect(f.surface.canvas.height).toBe(40)
      expect(f.surface.transforms.at(-1)).toEqual([1.25, 0, 0, 1.25, 0, 0])
      f.surface.resize(1.75)
      expect(f.surface.canvas.width).toBe(263)
      expect(f.surface.canvas.height).toBe(56)
      yield* Scope.close(scope, Exit.void)
      expect(f.surface.observed).toBe(0)
    }),
  )
  it.effect('fills the measured slot up to nominal widths and draws fitted, unsqueezed text', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const surface = testCanvas()
      const store = makeSeriesStore()
      const series = makeSeries<NumberValue>({
        id: 'heap',
        label: 'JS heap (approximate)',
        unit: 'bytes',
        capacity: 4,
      })
      store.register({ series }).append({
        sample: { _tag: 'Value', atMs: 0, value: { _tag: 'Number', value: 156_342_272 } },
      })
      const meters = { store, clock: makeMeters({ sources: [], platform: host.platform }).clock }
      const layouts: number[] = []
      const blocks = [
        numberBlock({ id: 'heap', series }),
        numberBlock({ id: 'heap-short', series, shortLabel: 'Heap' }),
      ]
      surface.setAvailableWidth(1000)
      const scope = yield* Scope.make()
      yield* Scope.provide(
        makeCanvasStrip({
          canvas: surface.canvas,
          meters,
          blocks,
          platform: surface.platform,
          readTheme: () => lightMeterTheme,
          onLayout: (layout) => layouts.push(layout.widthPx),
        }).attach,
        scope,
      )
      expect(layouts).toEqual([302])
      // At nominal 150px, use the short label rather than truncating the full heap label.
      expect(surface.drawnTexts.map((text) => text.text)).toEqual([
        '149.1 MiB',
        'Heap',
        '149.1 MiB',
      ])
      surface.drawnTexts.length = 0
      surface.setAvailableWidth(202)
      expect(layouts).toEqual([302, 202])
      expect(surface.canvas.style.width).toBe('202px')
      expect(surface.canvas.width).toBe(253)
      expect(surface.drawnTexts.every((text) => text.maxWidth === undefined)).toBe(true)
      // At 100px, drop a label that cannot fit; keep a supplied short label intact.
      expect(surface.drawnTexts.map((text) => [text.text, text.x])).toEqual([
        ['149.1 MiB', 42],
        ['Heap', 106],
        ['149.1 MiB', 144],
      ])
      yield* Scope.close(scope, Exit.void)
    }),
  )
  it.effect(
    'draws source-phase values before Draw and keeps frozen readers independent of collection',
    () =>
      Effect.gen(function* () {
        const f = fixture()
        const lease = yield* Scope.make()
        const drawScope = yield* Scope.make()
        yield* Scope.provide(f.meters.start, lease)
        const live = makeStripView({ store: f.meters.store, blocks: f.blocks })
        yield* Scope.provide(
          makeCanvasStrip({
            canvas: f.surface.canvas,
            meters: f.meters,
            blocks: f.blocks,
            view: live,
            platform: f.surface.platform,
            readTheme: () => lightMeterTheme,
          }).attach,
          drawScope,
        )
        f.host.tick(250)
        const text = live.getSnapshot()[0]
        expect(f.surface.texts.at(-1)).toBe(text)
        const frozen = makeStripView({
          store: f.meters.store,
          blocks: f.blocks,
          frozenAtMs: f.meters.clock.now(),
        })
        const frozenText = frozen.getSnapshot()[0]
        f.host.tick(250)
        expect(frozen.getSnapshot()[0]).toBe(frozenText)
        expect(live.getSnapshot()[0]).not.toBe(frozenText)
        expect(f.started).toBe(1)
        expect(f.host.pending).toBe(1)
        yield* Scope.close(drawScope, Exit.void)
        expect(f.host.pending).toBe(1)
        yield* Scope.close(lease, Exit.void)
        expect(f.host.pending).toBe(0)
      }),
  )
  it.effect('publishes live text at 250ms while canvas and headless reads remain current', () =>
    Effect.gen(function* () {
      const f = fixture()
      const scope = yield* Scope.make()
      yield* Scope.provide(f.meters.start, scope)
      const live = makeStripView({ store: f.meters.store, blocks: f.blocks })
      const initial = live.getSnapshot()
      const notify = vi.fn()
      const unsubscribe = live.subscribe(notify)
      yield* Scope.provide(
        makeCanvasStrip({
          canvas: f.surface.canvas,
          meters: f.meters,
          blocks: f.blocks,
          view: live,
          platform: f.surface.platform,
          readTheme: () => lightMeterTheme,
        }).attach,
        scope,
      )
      // The first visible tick anchors publication; the next 250ms boundary is at 260ms.
      for (let index = 0; index < 25; index++) f.host.tick(10)
      expect(notify).not.toHaveBeenCalled()
      expect(live.getSnapshot()).toBe(initial)
      expect(f.meters.headless.snapshotSeries({ series: f.series }).samples.at(-1)).toEqual({
        _tag: 'Value',
        atMs: 250,
        value: { _tag: 'Number', value: 25 },
      })
      expect(f.surface.texts.at(-1)).toBe(live.readers[0]?.describe())
      expect(f.surface.texts.at(-1)).not.toBe(initial[0])
      f.host.tick(10)
      expect(notify).toHaveBeenCalledTimes(1)
      const published = live.getSnapshot()
      expect(published).not.toBe(initial)
      expect(published[0]).toBe(f.surface.texts.at(-1))
      const frozen = makeStripView({
        store: f.meters.store,
        blocks: f.blocks,
        frozenAtMs: f.meters.clock.now(),
      })
      const frozenSnapshot = frozen.getSnapshot()
      const frozenNotify = vi.fn()
      const stopFrozen = frozen.subscribe(frozenNotify)
      for (let index = 0; index < 24; index++) f.host.tick(10)
      expect(live.getSnapshot()).toBe(published)
      expect(notify).toHaveBeenCalledTimes(1)
      f.host.tick(10)
      expect(notify).toHaveBeenCalledTimes(2)
      expect(frozen.getSnapshot()).toBe(frozenSnapshot)
      expect(frozenNotify).not.toHaveBeenCalled()
      unsubscribe()
      stopFrozen()
      f.host.tick(250)
      expect(notify).toHaveBeenCalledTimes(2)
      yield* Scope.close(scope, Exit.void)
      expect(f.host.pending).toBe(0)
      expect(f.surface.observed).toBe(0)
      expect(notify).toHaveBeenCalledTimes(2)
    }),
  )
  it.effect('empty strips install no drawing or browser observers', () =>
    Effect.gen(function* () {
      const f = fixture()
      yield* makeCanvasStrip({
        canvas: f.surface.canvas,
        meters: f.meters,
        blocks: [],
        platform: f.surface.platform,
        readTheme: () => lightMeterTheme,
      }).attach.pipe(Effect.scoped)
      expect(f.surface.observed).toBe(0)
      expect(f.host.requests).toBe(0)
      expect(f.surface.texts).toEqual([])
    }),
  )
  it('formats compact values from observed scalars in the same displayed unit', () => {
    for (const [value, unit, full, compact, number] of [
      [59.9, 'fps', '59.9 fps', '60fps', '60'],
      [526, 'ms', '526 ms', '526ms', '526'],
      [95.3 * 1024 ** 2, 'bytes', '95.3 MiB', '95MiB', '95'],
      [1.6 * 1024 ** 3, 'bytes', '1.6 GiB', '2GiB', '2'],
      [1.6 * 1024, 'bytes', '1.6 KiB', '2KiB', '2'],
      [526, 'bytes', '526 B', '526B', '526'],
      [12.6, 'count', '12.6', '13', '13'],
      [-12.6, 'ms', '-12.6 ms', '-13ms', '-13'],
      [0, 'fps', '0 fps', '0fps', '0'],
    ] as const) {
      expect(formatMeterValue({ value, unit })).toBe(full)
      expect(formatMeterValue({ value, unit, format: 'compact' })).toBe(compact)
      expect(formatMeterValue({ value, unit, format: 'number' })).toBe(number)
    }
  })
  it('draws compact scalars before ellipsizing while retaining full accessible descriptions', () => {
    const surface = testCanvas()
    const ctx = surface.canvas.getContext('2d')
    if (ctx === null) throw new TypeError('Injected canvas context is required')
    for (const [unit, value, width, full, drawn] of [
      ['fps', 59.9, 50, '59.9 fps', '60fps'],
      ['ms', 526, 40, '526 ms', '526ms'],
      ['bytes', 95.3 * 1024 ** 2, 50, '95.3 MiB', '95MiB'],
      ['fps', 59.9, 20, '59.9 fps', '60'],
    ] as const) {
      const series = makeSeries<NumberValue>({
        id: 'scalar',
        label: 'Measured value',
        unit,
        capacity: 4,
      })
      const store = makeSeriesStore()
      store.register({ series }).append({
        sample: { _tag: 'Value', atMs: 0, value: { _tag: 'Number', value } },
      })
      const reader = numberBlock({ id: 'scalar', series, shortLabel: 'Value' }).read(store)
      surface.drawnTexts.length = 0
      reader.draw({
        ctx,
        rect: { x: 0, y: 0, width, height: 32 },
        nowMs: 0,
        historyMs: 100,
        theme: lightMeterTheme,
      })
      expect(surface.drawnTexts.map((text) => text.text)).toEqual([drawn])
      expect(surface.drawnTexts.every((text) => text.maxWidth === undefined)).toBe(true)
      expect(reader.describe()).toBe(full)
    }
  })
  it('compacts actual frame timing without substituting calibration or missing samples', () => {
    const surface = testCanvas()
    const ctx = surface.canvas.getContext('2d')
    if (ctx === null) throw new TypeError('Injected canvas context is required')
    const series = makeSeries<FpsValue>({
      id: 'frames',
      label: 'Frame rate',
      unit: 'fps',
      capacity: 4,
    })
    const store = makeSeriesStore()
    const writer = store.register({ series })
    const value: FpsValue = {
      _tag: 'Fps',
      durationMs: 1000 / 59.9,
      skippedFrames: { _tag: 'Unavailable', atMs: 0, reason: 'NoSamples' },
      framesCaptured: 1,
      calibration: { _tag: 'Calibrated', bucket: 240 },
    }
    writer.append({ sample: { _tag: 'Value', atMs: 0, value } })
    const reader = frameBlock({ id: 'frames', series, shortLabel: 'FPS' }).read(store)
    reader.draw({
      ctx,
      rect: { x: 0, y: 0, width: 50, height: 32 },
      nowMs: 0,
      historyMs: 100,
      theme: lightMeterTheme,
    })
    expect(surface.drawnTexts.map((text) => text.text)).toEqual(['60fps'])
    expect(reader.describe()).toBe('59.9 fps')
    writer.append({
      sample: { _tag: 'Value', atMs: 1, value: { ...value, durationMs: 0 } },
    })
    surface.drawnTexts.length = 0
    reader.draw({
      ctx,
      rect: { x: 0, y: 0, width: 150, height: 32 },
      nowMs: 1,
      historyMs: 100,
      theme: lightMeterTheme,
    })
    expect(surface.drawnTexts.map((text) => text.text)).toEqual(['FPS', 'n/a (NoSamples)'])
    expect(reader.describe()).toBe('n/a (NoSamples)')
  })
  it('aggregates cumulative counter increments by timestamp bin and overlays explicit gap durations', () => {
    const surface = testCanvas()
    const series = makeSeries<NumberValue>({
      id: 'events',
      label: 'Events',
      unit: 'count',
      capacity: 10,
    })
    const store = makeSeriesStore()
    const writer = store.register({ series })
    for (const [atMs, value] of [
      [50, 10],
      [55, 13],
      [56, 15],
    ] as const) {
      writer.append({ sample: { _tag: 'Value', atMs, value: { _tag: 'Number', value } } })
    }
    const reader = counterBlock({ id: 'events', series, widthPx: 16 }).read(store)
    const ctx = surface.canvas.getContext('2d')
    if (ctx === null) throw new TypeError('Injected canvas context is required')
    reader.draw({
      ctx,
      rect: { x: 0, y: 0, width: 16, height: 32 },
      nowMs: 100,
      historyMs: 100,
      theme: lightMeterTheme,
    })
    expect(surface.rectangles).toContainEqual([8, 18, 1, 12])
    expect(reader.describe()).toBe('15')
    writer.append({ sample: { _tag: 'Gap', atMs: 75, durationMs: 25, reason: 'Hidden' } })
    reader.draw({
      ctx,
      rect: { x: 0, y: 0, width: 16, height: 32 },
      nowMs: 100,
      historyMs: 100,
      theme: lightMeterTheme,
    })
    expect(surface.rectangles).toContainEqual([8, 18, 2, 12])
    expect(reader.describe()).toBe('n/a (Hidden gap)')
  })
  it('accepts semantic CSS-variable token objects without a styling-framework dependency', () => {
    const surface = testCanvas()
    document.body.append(surface.canvas)
    surface.canvas.style.setProperty('--meter-foreground', '#123456')
    expect(
      resolveMeterTheme({
        canvas: surface.canvas,
        theme: { ...lightMeterTheme, foreground: 'var(--meter-foreground)' },
      }).foreground,
    ).toBe('#123456')
    expect(
      resolveMeterTheme({
        canvas: surface.canvas,
        theme: { ...lightMeterTheme, foreground: 'var(--missing, #654321)' },
      }).foreground,
    ).toBe('#654321')
    surface.canvas.remove()
  })
  it.effect('describes unavailable evidence without substituting zero', () =>
    Effect.gen(function* () {
      const f = fixture()
      const view = makeStripView({ store: f.meters.store, blocks: f.blocks })
      expect(view.getSnapshot()).toEqual(['n/a (NoSamples)'])
      const writer = f.meters.store.register({ series: f.series })
      writer.append({ sample: { _tag: 'Unavailable', atMs: 0, reason: 'Unsupported' } })
      expect(view.getSnapshot()).toEqual(['n/a (Unsupported)'])
    }),
  )
})
