// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'
import { vi } from 'vitest'

import {
  bucketSeries,
  makeSeries,
  makeSeriesStore,
  type NumberValue,
  type Sample,
} from '../series/index.ts'
import { testPlatform } from '../session/_test-platform.ts'
import type { FpsValue } from '../session/frame.ts'
import { makeMeters, makeSource } from '../session/index.ts'
import { testCanvas } from './_test-canvas.ts'
import {
  block,
  type BlockReader,
  resolveBlockAggregation,
  type BlockAggregation,
  type DrawInput,
  counterBlock,
  formatMeterValue,
  formatRange,
  frameBlock,
  layoutStrip,
  lightMeterTheme,
  makeCanvasStrip,
  makeStripView,
  numberBlock,
  numericBlock,
  plotRange,
  resolveMeterTheme,
  tileBlock,
  type TileAggregation,
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
  it('resolves completed bucket metadata from explicit time and validates its derived domain', () => {
    const aggregation = {
      _tag: 'Bucket',
      mode: 'Event',
      bucketMs: 1000,
      buckets: 2,
      unit: 'count',
    } satisfies BlockAggregation
    expect(resolveBlockAggregation({ nowMs: 1250 })).toEqual({ _tag: 'Latest' })
    expect(resolveBlockAggregation({ aggregation, nowMs: 1250 })).toEqual({
      ...aggregation,
      endMs: 1000,
    })
    expect(resolveBlockAggregation({ aggregation, nowMs: 2000 })).toEqual({
      ...aggregation,
      endMs: 2000,
    })
    for (const invalid of [
      { bucketMs: 0 },
      { bucketMs: -1 },
      { bucketMs: Infinity },
      { buckets: 0 },
      { buckets: 1.5 },
      { bucketMs: Number.MAX_VALUE / 2, buckets: 2 },
    ])
      expect(() =>
        resolveBlockAggregation({
          aggregation: { ...aggregation, ...invalid },
          nowMs: 1250,
        }),
      ).toThrow(TypeError)
    for (const nowMs of [NaN, Infinity, -Number.MAX_VALUE])
      expect(() =>
        resolveBlockAggregation({
          aggregation: { ...aggregation, bucketMs: Number.MAX_VALUE, buckets: 1 },
          nowMs,
        }),
      ).toThrow(TypeError)
  })

  it.effect(
    'publishes time-only bucket text and preserves explicit-time frozen parity and array identity',
    () =>
      Effect.gen(function* () {
        const host = testPlatform()
        const surface = testCanvas()
        const ctx = surface.canvas.getContext('2d')
        if (ctx === null) throw new TypeError('Injected canvas context is required')
        const meters = makeMeters({ sources: [], platform: host.platform })
        const series = makeSeries<NumberValue>({
          id: 'time',
          label: 'Timed events',
          unit: 'ms',
          capacity: 4,
        })
        meters.store.register({ series }).append({
          sample: { _tag: 'Value', atMs: 500, value: { _tag: 'Number', value: 7 } },
        })
        const aggregation = {
          _tag: 'Bucket',
          mode: 'Event',
          bucketMs: 1000,
          buckets: 1,
          unit: 'count',
        } satisfies BlockAggregation
        const describeBucket = ({
          history,
          nowMs,
        }: Pick<DrawInput<NumberValue>, 'history' | 'nowMs'>): string => {
          const policy = resolveBlockAggregation({ aggregation, nowMs })
          if (policy._tag !== 'Bucket') throw new TypeError('Expected bucket policy')
          const values = bucketSeries({ ...policy, history, value: (value) => value.value })
          const value = values.at(-1)
          return value === undefined ? 'n/a' : formatMeterValue({ value, unit: policy.unit })
        }
        const blocks = [
          block({
            id: 'time',
            series,
            widthPx: 100,
            aggregation,
            describe: describeBucket,
            draw: (input) => input.ctx.fillText(describeBucket(input), input.rect.x, input.rect.y),
          }),
        ]
        let explicitNow = 250
        const unsubscribed = makeStripView({
          store: meters.store,
          blocks,
          now: () => explicitNow,
        })
        expect(unsubscribed.getSnapshot()).toEqual(['n/a'])
        explicitNow = 1250
        expect(unsubscribed.getSnapshot()).toEqual(['7'])
        host.advance(1250)
        const scope = yield* Scope.make()
        yield* Scope.provide(meters.start, scope)
        const live = makeStripView({ store: meters.store, blocks, now: meters.clock.now })
        const unusedNow = vi.fn(() => NaN)
        const frozen = makeStripView({
          store: meters.store,
          blocks,
          now: unusedNow,
          frozenAtMs: meters.clock.now(),
        })
        const reader = live.readers[0]
        const frozenReader = frozen.readers[0]
        if (reader === undefined || frozenReader === undefined)
          throw new TypeError('Expected readers')
        const initial = live.getSnapshot()
        expect(initial).toEqual(['7'])
        expect(frozen.getSnapshot()).toEqual(initial)
        const evidence = reader.evidence({ nowMs: 1250 })
        expect(evidence).toEqual(frozenReader.evidence({ nowMs: 1250 }))
        expect(evidence).toMatchObject({
          text: '7',
          unit: 'count',
          evaluatedAtMs: 1250,
          latest: { _tag: 'Value', atMs: 500 },
          aggregation: { ...aggregation, endMs: 1000 },
        })
        const revision = reader.revision()
        const notify = vi.fn()
        const stop = live.subscribe(notify)
        host.tick(10)
        host.tick(250)
        expect(live.getSnapshot()).toBe(initial)
        expect(notify).not.toHaveBeenCalled()
        host.tick(750)
        const published = live.getSnapshot()
        expect(published).toEqual(['0'])
        expect(published).not.toBe(initial)
        expect(reader.revision()).toBe(revision)
        expect(notify).toHaveBeenCalledTimes(1)
        expect(frozen.getSnapshot()).toEqual(initial)
        expect(unusedNow).not.toHaveBeenCalled()
        // A snapshot copies data only; readers always honor the supplied time.
        expect(frozenReader.describe({ nowMs: meters.clock.now() })).toBe('0')
        const frozenNow = frozen.frozenAtMs ?? meters.clock.now()
        expect(frozenReader.evidence({ nowMs: frozenNow })).toEqual(evidence)
        frozenReader.draw({
          ctx,
          rect: { x: 0, y: 0, width: 100, height: 32 },
          nowMs: frozenNow,
          historyMs: 99,
          theme: lightMeterTheme,
        })
        expect(surface.texts.at(-1)).toBe(evidence.text)
        reader.draw({
          ctx,
          rect: { x: 0, y: 0, width: 100, height: 32 },
          nowMs: meters.clock.now(),
          historyMs: 9999,
          theme: lightMeterTheme,
        })
        expect(surface.texts.at(-1)).toBe(reader.evidence({ nowMs: meters.clock.now() }).text)
        host.advance(1000)
        expect(live.getSnapshot()).toBe(published)
        stop()
        expect(live.getSnapshot()).toBe(published)
        const numeric = numberBlock({ id: 'latest', series }).read(meters.store)
        expect(numeric.describe({ nowMs: meters.clock.now() })).toBe('7 ms')
        expect(numeric.evidence({ nowMs: meters.clock.now() })).toMatchObject({
          text: '7 ms',
          unit: 'ms',
          latest: { _tag: 'Value', atMs: 500 },
          aggregation: { _tag: 'Latest' },
        })
        yield* Scope.close(scope, Exit.void)
      }),
  )
  it('captures on-demand typed evidence from the same live or frozen reader', () => {
    const series = makeSeries<NumberValue>({
      id: 'evidence',
      label: 'Elapsed',
      unit: 'ms',
      capacity: 2,
    })
    const store = makeSeriesStore()
    const writer = store.register({ series })
    const reader = numberBlock({ id: 'evidence', series }).read(store)
    expect(reader.evidence({ nowMs: 10 })).toMatchObject({
      label: 'Elapsed',
      unit: 'ms',
      text: 'n/a (NoSamples)',
      evaluatedAtMs: 10,
      latest: undefined,
    })
    writer.append({ sample: { _tag: 'Value', atMs: 11, value: { _tag: 'Number', value: 12.6 } } })
    const frozen = reader.snapshot()
    const captured = reader.evidence({ nowMs: 20 })
    expect(captured).toEqual(frozen.evidence({ nowMs: 20 }))
    expect(captured.text).toBe('12.6 ms')
    expect(captured.text).toBe(reader.describe({ nowMs: 20 }))
    expect(captured.latest).toEqual({ _tag: 'Value', atMs: 11 })
    const extraPayload = { secret: 'not evidence' }
    const gap = {
      _tag: 'Gap',
      atMs: 21,
      durationMs: 10,
      reason: 'Hidden',
      value: extraPayload,
    } satisfies Sample<NumberValue> & { readonly value: { readonly secret: string } }
    writer.append({ sample: gap })
    expect(reader.evidence({ nowMs: 22 })).toMatchObject({
      text: 'n/a (Hidden gap)',
      latest: { _tag: 'Gap', atMs: 21, durationMs: 10, reason: 'Hidden' },
    })
    const gapEvidence = reader.evidence({ nowMs: 22 })
    expect(gapEvidence.latest).toEqual({
      _tag: 'Gap',
      atMs: 21,
      durationMs: 10,
      reason: 'Hidden',
    })
    expect(gapEvidence).toEqual(reader.snapshot().evidence({ nowMs: 22 }))
    const unavailableSample = {
      _tag: 'Unavailable',
      atMs: 23,
      reason: 'MeasurementFailed',
      value: extraPayload,
    } satisfies Sample<NumberValue> & { readonly value: { readonly secret: string } }
    writer.append({ sample: unavailableSample })
    const unavailable = reader.evidence({ nowMs: 24 })
    expect(unavailable).toEqual(reader.snapshot().evidence({ nowMs: 24 }))
    expect(unavailable).toMatchObject({
      text: 'n/a (MeasurementFailed)',
      latest: { _tag: 'Unavailable', atMs: 23, reason: 'MeasurementFailed' },
      retention: {
        capacity: 2,
        length: 2,
        oldestAtMs: 21,
        newestAtMs: 23,
        overflowCount: 1,
        firstRetainedSequence: 1,
        nextSequence: 3,
      },
    })
    expect(unavailable.latest).toEqual({
      _tag: 'Unavailable',
      atMs: 23,
      reason: 'MeasurementFailed',
    })
    extraPayload.secret = 'changed after capture'
    expect(unavailable).toEqual(reader.snapshot().evidence({ nowMs: 24 }))
    expect(gapEvidence.latest).toEqual({
      _tag: 'Gap',
      atMs: 21,
      durationMs: 10,
      reason: 'Hidden',
    })
    expect(frozen.evidence({ nowMs: 20 })).toEqual(captured)
    expect(captured.retention.overflowCount).toBe(0)
  })

  it('preserves original production rectangles for scalar and stacked bins, including overflow', () => {
    // Reference transcribed from the pre-extraction production loops. Deliberately
    // retain their distinct omitted-range extent scan and floating boundaries.
    for (const mode of ['Gauge', 'Event', 'Counter'] as const) {
      for (const explicit of [false, true]) {
        for (const { stacked, overflow } of [
          { stacked: false, overflow: false },
          { stacked: true, overflow: false },
          { stacked: false, overflow: true },
          { stacked: true, overflow: true },
        ]) {
          const samples: readonly Sample<number>[] = [
            { _tag: 'Value', atMs: 0, value: 3 },
            { _tag: 'Value', atMs: 10, value: 4 },
            { _tag: 'Value', atMs: 10.1, value: 6 },
            { _tag: 'Value', atMs: 10.2, value: 8 },
            { _tag: 'Gap', atMs: 10.3, durationMs: 0.1, reason: 'Hidden' },
            { _tag: 'Value', atMs: 10.4, value: overflow === true ? -Number.MAX_VALUE : 2 },
            { _tag: 'Value', atMs: 10.5, value: overflow === true ? Number.MAX_VALUE : 10 },
            { _tag: 'Value', atMs: 10.6, value: overflow === true ? Number.MAX_VALUE : 15 },
            { _tag: 'Unavailable', atMs: 10.9, reason: 'Stopped' },
          ]
          const values = (value: number) => (stacked === true ? [value / 2, value / 2] : value)
          const total = (value: number) => {
            const parts = values(value)
            return typeof parts === 'number' ? parts : parts.reduce((sum, part) => sum + part, 0)
          }
          const surface = testCanvas()
          const ctx = surface.canvas.getContext('2d')
          if (ctx === null) throw new TypeError('Injected canvas context is required')
          const series = makeSeries<number>({
            id: 'golden',
            label: '',
            unit: 'count',
            capacity: 20,
          })
          const store = makeSeriesStore()
          const writer = store.register({ series })
          for (const sample of samples) writer.append({ sample })
          let lo = explicit === true ? -10 : 0
          let hi = explicit === true ? 10 : 1
          const bins = 7
          const nowMs = 11
          const historyMs = 1
          const startMs = nowMs - historyMs
          const binMs = historyMs / bins
          if (explicit === false) {
            let prior: number | undefined
            let aggregate = 0
            let aggregateBin = -1
            for (const sample of samples) {
              if (sample._tag !== 'Value') {
                prior = undefined
                continue
              }
              const value = total(sample.value)
              if (Number.isFinite(value) === false) {
                prior = undefined
                continue
              }
              const increment =
                mode === 'Counter' ? (prior === undefined ? 0 : Math.max(0, value - prior)) : value
              prior = value
              if (sample.atMs < startMs) {
                if (mode === 'Gauge') {
                  hi = Math.max(1, value)
                  lo = Math.min(0, value)
                }
                continue
              }
              const bin = Math.max(
                0,
                Math.min(bins - 1, Math.ceil((sample.atMs - startMs) / binMs) - 1),
              )
              if (bin !== aggregateBin) {
                aggregate = 0
                aggregateBin = bin
              }
              aggregate += increment
              hi = Math.max(hi, mode === 'Gauge' ? value : aggregate)
              if (mode === 'Gauge') lo = Math.min(lo, value)
            }
          }
          const scale = explicit === true ? Math.max(Math.abs(lo), Math.abs(hi)) : 1
          const span = hi / scale - lo / scale
          const expected: number[][] = [[0, 0, 15, 32]]
          let index = 0
          let previous = samples[0]
          let prior: number | undefined
          for (let bin = 0; bin < bins; bin++) {
            const end = nowMs - historyMs + ((bin + 1) * historyMs) / bins
            let aggregate = 0
            while (index < samples.length) {
              const sample = samples[index]
              if (sample === undefined || sample.atMs > end) break
              previous = sample
              if (sample._tag === 'Value') {
                const value = total(sample.value)
                const increment =
                  mode === 'Counter'
                    ? prior === undefined
                      ? 0
                      : Math.max(0, value - prior)
                    : value
                if (sample.atMs > end - binMs) aggregate += increment
                if (explicit === true)
                  aggregate = Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, aggregate))
                prior = value
              } else prior = undefined
              index++
            }
            if (previous === undefined || previous.atMs > end) continue
            const x = 4 + ((end - binMs - (nowMs - historyMs)) / historyMs) * 7
            if (previous._tag !== 'Value') {
              expected.push([x, 18, 1, 12])
              continue
            }
            const parts = mode === 'Gauge' ? values(previous.value) : aggregate
            let bottom = 18 + (12 * (hi / scale)) / span
            let sum = 0
            for (const value of typeof parts === 'number' ? [parts] : parts) {
              if (Number.isFinite(value) === false) continue
              let height = (value / scale / span) * 12
              if (explicit === true) {
                const baseline = Math.max(lo, Math.min(hi, sum)) / scale
                sum = Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, sum + value))
                const top = Math.max(lo, Math.min(hi, sum)) / scale
                bottom = 18 + 12 * ((hi / scale - baseline) / span)
                height = 12 * ((top - baseline) / span)
              }
              bottom -= height
              expected.push([x, bottom, 1, height])
            }
          }
          // Duration overlay uses the existing historyX arithmetic.
          expected.push([4 + ((10.3 - 0.1 - startMs) / historyMs) * 7, 18, 1, 12])
          numericBlock({
            id: 'golden',
            series,
            values,
            mode,
            ...(explicit === true ? { range: { lo, hi } } : {}),
          })
            .read(store)
            .draw({
              ctx,
              rect: { x: 0, y: 0, width: 15, height: 32 },
              nowMs,
              historyMs,
              theme: lightMeterTheme,
            })
          expect(surface.rectangles).toEqual(expected)
        }
      }
    }
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
      expect(reader.describe({ nowMs: 100 })).toBe('50 ms')
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
        const live = makeStripView({
          store: f.meters.store,
          blocks: f.blocks,
          now: f.meters.clock.now,
        })
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
          now: f.meters.clock.now,
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
      const live = makeStripView({
        store: f.meters.store,
        blocks: f.blocks,
        now: f.meters.clock.now,
      })
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
      expect(f.surface.texts.at(-1)).toBe(
        live.readers[0]?.describe({ nowMs: f.meters.clock.now() }),
      )
      expect(f.surface.texts.at(-1)).not.toBe(initial[0])
      f.host.tick(10)
      expect(notify).toHaveBeenCalledTimes(1)
      const published = live.getSnapshot()
      expect(published).not.toBe(initial)
      expect(published[0]).toBe(f.surface.texts.at(-1))
      const frozen = makeStripView({
        store: f.meters.store,
        blocks: f.blocks,
        now: f.meters.clock.now,
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
      expect(reader.describe({ nowMs: 0 })).toBe(full)
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
    expect(reader.describe({ nowMs: 0 })).toBe('59.9 fps')
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
    expect(reader.describe({ nowMs: 1 })).toBe('n/a (NoSamples)')
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
    expect(reader.describe({ nowMs: 100 })).toBe('15')
    writer.append({ sample: { _tag: 'Gap', atMs: 75, durationMs: 25, reason: 'Hidden' } })
    reader.draw({
      ctx,
      rect: { x: 0, y: 0, width: 16, height: 32 },
      nowMs: 100,
      historyMs: 100,
      theme: lightMeterTheme,
    })
    expect(surface.rectangles).toContainEqual([8, 18, 2, 12])
    expect(reader.describe({ nowMs: 100 })).toBe('n/a (Hidden gap)')
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
      const view = makeStripView({
        store: f.meters.store,
        blocks: f.blocks,
        now: f.meters.clock.now,
      })
      expect(view.getSnapshot()).toEqual(['n/a (NoSamples)'])
      const writer = f.meters.store.register({ series: f.series })
      writer.append({ sample: { _tag: 'Unavailable', atMs: 0, reason: 'Unsupported' } })
      expect(view.getSnapshot()).toEqual(['n/a (Unsupported)'])
    }),
  )
})

describe('tile block', () => {
  const gauge = {
    _tag: 'Bucket',
    mode: 'Gauge',
    bucketMs: 1000,
    buckets: 4,
    unit: 'count',
  } satisfies TileAggregation
  const rect = { x: 0, y: 0, width: 88, height: 48 }
  const tileFixture = (aggregation: TileAggregation = gauge) => {
    const surface = testCanvas()
    const ctx = surface.canvas.getContext('2d')
    if (ctx === null) throw new TypeError('Injected canvas context is required')
    const series = makeSeries<NumberValue>({
      id: 'tile',
      label: 'Requests',
      unit: 'count',
      capacity: 16,
    })
    const store = makeSeriesStore()
    const writer = store.register({ series })
    const make = (options: Partial<Parameters<typeof tileBlock<NumberValue>>[0]> = {}) =>
      tileBlock({
        id: 'tile',
        series,
        widthPx: rect.width,
        aggregation,
        value: (value) => value.value,
        ...options,
      })
    const reader = make().read(store)
    const draw = (options: {
      readonly nowMs: number
      readonly target?: typeof reader
      readonly width?: number
    }) => {
      surface.context.clearRect()
      surface.texts.length = 0
      surface.drawnTexts.length = 0
      ;(options.target ?? reader).draw({
        ctx,
        rect: { ...rect, width: options.width ?? rect.width },
        nowMs: options.nowMs,
        historyMs: 1,
        theme: lightMeterTheme,
      })
    }
    const append = (sample: Sample<NumberValue>) => writer.append({ sample })
    const value = (atMs: number, number: number) =>
      append({ _tag: 'Value', atMs, value: { _tag: 'Number', value: number } })
    return { surface, series, store, reader, make, draw, append, value }
  }
  // Chart geometry shared with numeric blocks: x+4, y+18, width-8, height-20.
  const chart = { x: 4, y: 18, width: 80, height: 28 }
  const step = chart.width / gauge.buckets
  const binX = (bin: number) => chart.x + (bin + 0.5) * step

  it('draws and describes the same completed buckets as bucketSeries at one explicit time', () => {
    const f = tileFixture()
    f.value(500, 2)
    f.value(1500, 4)
    f.value(3500, 8)
    const nowMs = 4250
    const policy = resolveBlockAggregation({ aggregation: gauge, nowMs })
    if (policy._tag !== 'Bucket') throw new TypeError('Expected bucket policy')
    const buckets = bucketSeries({
      ...policy,
      history: f.store.read({ series: f.series }),
      value: (value) => value.value,
    })
    expect(buckets).toEqual([2, 4, 4, 8])
    const text = formatMeterValue({ value: 8, unit: 'count' })
    expect(f.reader.describe({ nowMs })).toBe(text)
    expect(f.reader.evidence({ nowMs })).toMatchObject({
      label: 'Requests',
      text,
      unit: 'count',
      evaluatedAtMs: nowMs,
      aggregation: { ...gauge, endMs: 4000 },
    })
    f.draw({ nowMs })
    // The label is always drawn (it is the static accessible name), then the value.
    expect(f.surface.texts).toEqual(['Requests', text])
    expect(f.surface.drawnTexts.every((drawn) => drawn.maxWidth === undefined)).toBe(true)
    // Default fixed range: [0, ceil(max(nominalMax, maximum))] = [0, 8].
    const y = (value: number) => chart.y + chart.height * ((8 - value) / 8)
    expect(f.surface.paths).toEqual([
      ['moveTo', binX(0), y(2)],
      ['lineTo', binX(1), y(4)],
      ['lineTo', binX(2), y(4)],
      ['lineTo', binX(3), y(8)],
      ['stroke', NaN, NaN],
    ])
    expect(f.surface.context.strokeStyle).toBe(lightMeterTheme.normal)
  })

  it('keeps live and frozen scratch separate so interleaved reads never retain stale bins', () => {
    const f = tileFixture()
    f.value(500, 2)
    f.value(1500, 4)
    const frozen = f.reader.snapshot()
    f.value(2500, 6)
    const nowMs = 3250
    expect(f.reader.describe({ nowMs })).toBe(formatMeterValue({ value: 6, unit: 'count' }))
    // Gauge holds the newest retained value into later buckets.
    expect(frozen.describe({ nowMs })).toBe(formatMeterValue({ value: 4, unit: 'count' }))
    expect(f.reader.describe({ nowMs })).toBe(formatMeterValue({ value: 6, unit: 'count' }))
    f.draw({ nowMs, target: frozen })
    expect(f.surface.texts.at(-1)).toBe(frozen.evidence({ nowMs }).text)
    f.draw({ nowMs })
    expect(f.surface.texts.at(-1)).toBe(f.reader.evidence({ nowMs }).text)
    // The live redraw after a frozen one plots live bins (range 0–6), not the frozen ones (0–4).
    expect(f.surface.paths.at(-3)?.[2]).toBeCloseTo(chart.y + chart.height / 3)
    // A second tile definition owns its own buffer; reads never leak between definitions.
    const other = f.make({ shortLabel: 'Req' }).read(f.store)
    expect(other.describe({ nowMs: 1250 })).toBe(formatMeterValue({ value: 2, unit: 'count' }))
    expect(f.reader.describe({ nowMs })).toBe(formatMeterValue({ value: 6, unit: 'count' }))
    f.draw({ nowMs, target: other })
    expect(f.surface.texts[0]).toBe('Req')
  })

  it('keeps a reader correct when its value callback reads a sibling reader, and rejects self re-entry', () => {
    const f = tileFixture()
    f.value(500, 2)
    f.value(1500, 4)
    let probe: BlockReader | undefined
    let nested = false
    const probed: string[] = []
    const spec = f.make({
      value: (value) => {
        if (probe !== undefined && nested === false) {
          nested = true
          probed.push(probe.describe({ nowMs: 1250 }))
          nested = false
        }
        return value.value
      },
    })
    const live = spec.read(f.store)
    probe = live.snapshot()
    f.value(2500, 6)
    // Each sibling read fills the frozen reader's own scratch mid-scan of the live reader.
    expect(live.describe({ nowMs: 3250 })).toBe(formatMeterValue({ value: 6, unit: 'count' }))
    expect(probed.length).toBeGreaterThan(0)
    const frozenText = formatMeterValue({ value: 2, unit: 'count' })
    expect(probed.every((probedText) => probedText === frozenText)).toBe(true)
    let self: typeof live | undefined
    const reentrant = f
      .make({
        value: (value) => {
          self?.describe({ nowMs: 3250 })
          return value.value
        },
      })
      .read(f.store)
    self = reentrant
    expect(() => reentrant.describe({ nowMs: 3250 })).toThrow(TypeError)
    // The guard is released after the failed read.
    self = undefined
    expect(reentrant.describe({ nowMs: 3250 })).toBe(formatMeterValue({ value: 6, unit: 'count' }))
  })

  it('draws the whole label as the static name and lets the value yield first', () => {
    const f = tileFixture()
    f.value(3500, 8)
    const nowMs = 4250
    // 'Requests' measures 48px; 56px leaves no room beside it after 4px padding per side.
    f.draw({ nowMs, width: 56 })
    expect(f.surface.texts).toEqual(['Requests'])
    // Narrower than the name: an ellipsized prefix, never a glyph-squeezed or clipped label.
    f.draw({ nowMs, width: 40 })
    expect(f.surface.texts).toHaveLength(1)
    expect(f.surface.texts[0]?.endsWith('…')).toBe(true)
    expect('Requests'.startsWith(f.surface.texts[0]?.slice(0, -1) ?? '')).toBe(true)
    expect(f.surface.drawnTexts.every((drawn) => drawn.maxWidth === undefined)).toBe(true)
    expect(f.reader.describe({ nowMs })).toBe(formatMeterValue({ value: 8, unit: 'count' }))
  })

  it('breaks the line at undefined buckets and keeps isolated observations visible', () => {
    const f = tileFixture()
    f.value(500, 2)
    f.append({ _tag: 'Unavailable', atMs: 1500, reason: 'NotConfigured' })
    f.value(2500, 4)
    f.append({ _tag: 'Gap', atMs: 3500, durationMs: 100, reason: 'MissedFrame' })
    f.draw({ nowMs: 4250 })
    const y = (value: number) => chart.y + chart.height * ((4 - value) / 4)
    expect(f.surface.paths).toEqual([
      ['moveTo', binX(0), y(2)],
      ['moveTo', binX(2), y(4)],
      ['stroke', NaN, NaN],
    ])
    expect(f.surface.rectangles.filter(([, , w, h]) => w === 2 && h === 2)).toEqual([
      [binX(0) - 1, y(2) - 1, 2, 2],
      [binX(2) - 1, y(4) - 1, 2, 2],
    ])
    expect(f.reader.describe({ nowMs: 4250 })).toBe('n/a (MissedFrame gap)')
    // At 88px beside 'Requests', 26px remain: the canvas draws a bare n/a; the reason stays in
    // the description.
    expect(f.surface.texts).toEqual(['Requests', 'n/a'])
    f.draw({ nowMs: 4250, width: 200 })
    expect(f.surface.texts).toEqual(['Requests', 'n/a (MissedFrame gap)'])
  })

  it('names the newest bucket state without substituting zero', () => {
    const f = tileFixture()
    expect(f.reader.describe({ nowMs: 4250 })).toBe('n/a (NoSamples)')
    f.draw({ nowMs: 4250, width: 200 })
    expect(f.surface.texts).toEqual(['Requests', 'n/a (NoSamples)'])
    expect(f.surface.paths).toEqual([['stroke', NaN, NaN]])
    f.append({ _tag: 'Unavailable', atMs: 1500, reason: 'NotConfigured' })
    expect(f.reader.describe({ nowMs: 2250 })).toBe('n/a (NotConfigured)')
    // A sample after the newest completed bucket end is not yet evidence for it.
    f.value(2500, 3)
    expect(f.reader.describe({ nowMs: 2250 })).toBe('n/a (NotConfigured)')
    expect(f.reader.describe({ nowMs: 3000 })).toBe(formatMeterValue({ value: 3, unit: 'count' }))
    // The store admits only finite observations; a non-finite projection is a failed measurement.
    const projected = f.make({ value: (value) => value.value / 0 }).read(f.store)
    expect(projected.describe({ nowMs: 3000 })).toBe('n/a (MeasurementFailed)')
  })

  it('reports the reduced bucket range in evidence only, absent when no bucket is defined', () => {
    const f = tileFixture()
    expect(f.reader.evidence({ nowMs: 4250 }).range).toBeUndefined()
    f.value(500, 2)
    f.value(1500, 4)
    f.value(3500, 8)
    expect(f.reader.evidence({ nowMs: 4250 }).range).toEqual({
      windowMs: 4000,
      endMs: 4000,
      minimum: 2,
      maximum: 8,
    })
    // Strip blocks keep their evidence shape.
    const strip = numberBlock({ id: 'plain', series: f.series }).read(f.store)
    expect('range' in strip.evidence({ nowMs: 4250 })).toBe(false)
  })

  it('reduces events and counters per completed bucket in the policy unit', () => {
    const events = tileFixture({ ...gauge, mode: 'Event', unit: 'count/s' })
    events.value(1100, 1)
    events.value(1200, 1)
    events.value(1300, 1)
    expect(events.reader.describe({ nowMs: 2500 })).toBe(
      formatMeterValue({ value: 3, unit: 'count/s' }),
    )
    expect(events.reader.describe({ nowMs: 3500 })).toBe(
      formatMeterValue({ value: 0, unit: 'count/s' }),
    )
    const counter = tileFixture({ ...gauge, mode: 'Counter' })
    counter.value(500, 10)
    counter.value(1200, 15)
    counter.value(1700, 12)
    counter.value(1800, 20)
    // Positive deltas only: +5, (reset), +8.
    expect(counter.reader.describe({ nowMs: 2000 })).toBe(
      formatMeterValue({ value: 13, unit: 'count' }),
    )
  })

  it('plots with auto, explicit, and marked ranges', () => {
    const f = tileFixture()
    f.value(500, 2)
    f.value(3500, 8)
    const nowMs = 4250
    const explicit = f.make({ range: { lo: 0, hi: 16 }, marks: [4, 32] }).read(f.store)
    f.draw({ nowMs, target: explicit })
    const y = (value: number) => chart.y + chart.height * ((16 - value) / 16)
    expect(f.surface.paths.at(-2)).toEqual(['lineTo', binX(3), y(8)])
    // Baseline plus the in-range mark only.
    expect(f.surface.rectangles.filter(([, , w, h]) => w === chart.width && h === 1)).toEqual([
      [chart.x, chart.y + chart.height - 1, chart.width, 1],
      [chart.x, y(4), chart.width, 1],
    ])
    const auto = f.make({ range: 'auto' }).read(f.store)
    f.draw({ nowMs, target: auto })
    const range = plotRange({ history: [2, 2, 2, 8], nominalMax: 1, mode: 'auto' })
    const autoY = (value: number) =>
      chart.y + chart.height * ((range.hi - value) / (range.hi - range.lo))
    expect(f.surface.paths[0]?.[2]).toBeCloseTo(autoY(2))
    expect(f.surface.paths.at(-2)?.[2]).toBeCloseTo(autoY(8))
    expect(() => f.make({ range: { lo: 1, hi: 1 } })).toThrow(TypeError)
    expect(() => f.make({ aggregation: { ...gauge, buckets: 0 } })).toThrow(TypeError)
  })
})
