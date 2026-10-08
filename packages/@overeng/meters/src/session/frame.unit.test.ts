import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'

import { makeSeries } from '../series/index.ts'
import { testPlatform } from './_test-platform.ts'
import { frameSource, makeMeters, type FpsValue } from './index.ts'

describe('frame bookkeeping', () => {
  it.effect.each([60, 120, 144, 160, 240])('calibrates a supported bucket %s', (bucket) =>
    Effect.gen(function* () {
      const host = testPlatform()
      const series = makeSeries<FpsValue>({
        id: 'frame',
        label: 'FPS',
        unit: 'fps',
        capacity: 2500,
      })
      const meters = makeMeters({
        platform: host.platform,
        sources: [frameSource({ id: 'frame', series })],
      })
      yield* meters.start
      host.tick(1000 / bucket)
      expect(meters.headless.snapshot().frames._tag).toBe('Unavailable')
      expect(meters.store.read({ series }).length).toBe(0)
      for (let index = 1; index < 110; index++) host.tick(1000 / bucket)
      const stats = meters.headless.snapshot().frames
      expect(stats._tag).toBe('Value')
      if (stats._tag === 'Value') {
        expect(stats.value.calibration).toEqual({ _tag: 'Calibrated', bucket })
        expect(stats.value.averageFps).toBeCloseTo(bucket)
        expect(stats.value.p50Ms).toBeCloseTo(1000 / bucket)
      }
      expect(meters.headless.snapshot()).toBe(meters.headless.snapshot())
    }),
  )

  it.effect('does not count hidden time or remount time as missed frames', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const series = makeSeries<FpsValue>({
        id: 'frame',
        label: 'FPS',
        unit: 'fps',
        capacity: 2500,
      })
      const meters = makeMeters({
        platform: host.platform,
        sources: [frameSource({ id: 'frame', series })],
      })
      const first = yield* Scope.make()
      yield* Scope.provide(meters.start, first)
      for (let index = 0; index < 110; index++) host.tick()
      const before = yield* meters.headless.beginMeasure
      host.tick(100)
      const dropped = yield* meters.headless.endMeasure({ handle: before })
      expect(dropped._tag).toBe('Complete')
      if (dropped._tag === 'Complete') expect(dropped.data.frameDrops).toBeGreaterThan(0)
      const hiddenHandle = yield* meters.headless.beginMeasure
      host.setVisible(false)
      expect(host.pending).toBe(0)
      host.advance(10000)
      host.setVisible(true)
      host.tick()
      const afterHidden = yield* meters.headless.endMeasure({ handle: hiddenHandle })
      expect(afterHidden._tag).toBe('Incomplete')
      if (afterHidden._tag === 'Incomplete' && afterHidden.data.frameDrops._tag === 'Value')
        expect(afterHidden.data.frameDrops.value.value).toBe(0)
      expect(
        meters.store
          .snapshotSeries({ series })
          .samples.some((sample) => sample._tag === 'Gap' && sample.reason === 'Hidden'),
      ).toBe(true)
      yield* Scope.close(first, Exit.succeed(undefined))
      host.advance(10000)
      const second = yield* Scope.make()
      yield* Scope.provide(meters.start, second)
      host.tick()
      host.tick()
      const remounted = meters.headless.snapshot().frames
      expect(remounted._tag).toBe('Value')
      if (remounted._tag === 'Value') expect(remounted.value.framesCaptured).toBe(114)
      yield* Scope.close(second, Exit.succeed(undefined))
    }),
  )

  it.effect('reports unsupported calibration and insufficient retained two-second history', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const series = makeSeries<FpsValue>({ id: 'frame', label: 'FPS', unit: 'fps', capacity: 10 })
      const meters = makeMeters({
        platform: host.platform,
        sources: [frameSource({ id: 'frame', series })],
      })
      yield* meters.start
      for (let index = 0; index < 110; index++) host.tick(1000 / 90)
      expect(meters.headless.snapshot().frames).toMatchObject({
        _tag: 'Unavailable',
        reason: 'HistoryLost',
      })
      const latest = meters.store.read({ series }).latest
      if (latest?._tag === 'Value')
        expect(latest.value.calibration).toMatchObject({ _tag: 'Unsupported', observedFps: 90 })
    }),
  )
  it.effect('records missing frame capability once without scheduling or hanging settlement', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const series = makeSeries<FpsValue>({ id: 'frame', label: 'FPS', unit: 'fps', capacity: 10 })
      const meters = makeMeters({
        platform: { ...host.platform, supportsFrames: () => false },
        sources: [frameSource({ id: 'frame', series })],
      })
      yield* meters.start
      expect(host.requests).toBe(0)
      expect(meters.store.read({ series }).length).toBe(1)
      expect(meters.store.read({ series }).latest).toMatchObject({
        _tag: 'Unavailable',
        reason: 'Unsupported',
      })
      expect(meters.headless.snapshot().frames).toMatchObject({
        _tag: 'Unavailable',
        reason: 'Unsupported',
      })
      expect((yield* Effect.flip(meters.clock.waitFrames({ count: 1 }))).reason).toBe('Stopped')
      const measurement = yield* meters.headless.measureWindow({ work: Effect.succeed('result') })
      expect(measurement.measurement._tag).toBe('Incomplete')
      if (measurement.measurement._tag === 'Incomplete')
        expect(measurement.measurement.reasons).toContain('NotConfigured')
      expect(host.requests).toBe(0)
    }),
  )
})
