// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'
import { vi } from 'vitest'

import { makeSeries, makeSeriesStore, type NumberValue } from '../series/index.ts'
import { testPlatform } from '../session/_test-platform.ts'
import { makeMeters, makeSource } from '../session/index.ts'
import { testCanvas } from './_test-canvas.ts'
import {
  counterBlock,
  layoutStrip,
  lightMeterTheme,
  makeCanvasStrip,
  makeStripView,
  numberBlock,
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
      surface.drawnTexts.length = 0
      surface.setAvailableWidth(202)
      expect(layouts).toEqual([302, 202])
      expect(surface.canvas.style.width).toBe('202px')
      expect(surface.canvas.width).toBe(253)
      expect(surface.drawnTexts.every((text) => text.maxWidth === undefined)).toBe(true)
      // Each 100px block: value reserved at the right, label ellipsized or shortened before it.
      expect(surface.drawnTexts.map((text) => [text.text, text.x])).toEqual([
        ['JS h…', 4],
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
