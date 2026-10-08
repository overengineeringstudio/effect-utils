import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Schema, Scope } from 'effect'

import {
  counterSource,
  counterToken,
  gaugeToken,
  makeInstrumentation,
} from '../instrumentation/index.ts'
import { makeSeries, type NumberValue } from '../series/index.ts'
import { testPlatform } from '../session/_test-platform.ts'
import { frameSource, makeMeters, makeSource, type FpsValue } from '../session/index.ts'

const fixture = (capacity = 2500) => {
  const host = testPlatform()
  const frame = makeSeries<FpsValue>({ id: 'frame', label: 'FPS', unit: 'fps', capacity })
  const token = counterToken({ id: 'jobs' })
  const gauge = gaugeToken({ id: 'queue' })
  const instrumentation = makeInstrumentation({ counters: [token], gauges: [gauge] })
  const count = makeSeries<NumberValue>({ id: 'jobs', label: 'Jobs', unit: 'count', capacity: 2 })
  const meters = makeMeters({
    platform: host.platform,
    sources: [
      frameSource({ id: 'frame', series: frame }),
      counterSource({ id: 'jobs', series: count, instrumentation, token }),
    ],
  })
  return { host, meters, instrumentation, token, gauge, frame, count }
}

describe('headless brackets', () => {
  it.effect.prop(
    'uses exact cumulative counter deltas independently of history eviction',
    [Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))],
    ([increment]) =>
      Effect.gen(function* () {
        const test = fixture()
        yield* test.meters.start
        for (let index = 0; index < 110; index++) test.host.tick()
        const handle = yield* test.meters.headless.beginMeasure
        test.instrumentation.counter({ token: test.token }).add({ by: increment })
        for (let index = 0; index < 4; index++)
          test.instrumentation.counter({ token: test.token }).add({ by: 0 })
        test.instrumentation.gauge({ token: test.gauge }).set({ value: -4 })
        test.host.tick()
        test.host.tick()
        const measurement = yield* test.meters.headless.endMeasure({ handle })
        expect(measurement._tag).toBe('Complete')
        expect(measurement.data.counterDelta).toEqual(increment === 0 ? {} : { jobs: increment })
        expect(measurement.data.framesCaptured).toBe(2)
        if (measurement._tag === 'Complete') expect(measurement.data.averageFps).toBe(60)
        expect(
          test.meters.headless.snapshotSeries({ series: test.count }).overflowCount,
        ).toBeGreaterThan(0)
      }),
  )

  it.effect('includes counters first appearing during a bracket', () =>
    Effect.gen(function* () {
      const test = fixture()
      let added = false
      const extra = makeSource({
        id: 'extra',
        series: makeSeries<number>({ id: 'extra', label: '', unit: 'count', capacity: 1 }),
        cadence: { _tag: 'Event' },
        evidence: { counters: () => (added === true ? { late: 7 } : {}) },
        start: () => Effect.void,
      })
      const meters = makeMeters({
        platform: test.host.platform,
        sources: [frameSource({ id: 'frame', series: test.frame }), extra],
      })
      yield* meters.start
      for (let index = 0; index < 110; index++) test.host.tick()
      const handle = yield* meters.headless.beginMeasure
      added = true
      test.host.tick()
      expect((yield* meters.headless.endMeasure({ handle })).data.counterDelta).toEqual({ late: 7 })
    }),
  )

  it.effect('defaults split settlement to zero and work settlement to thirty actual frames', () =>
    Effect.gen(function* () {
      const test = fixture()
      yield* test.meters.start
      for (let index = 0; index < 110; index++) test.host.tick()
      const handle = yield* test.meters.headless.beginMeasure
      test.host.tick()
      expect((yield* test.meters.headless.endMeasure({ handle })).data.framesCaptured).toBe(1)
      let done = false
      const window = yield* Effect.forkChild(
        test.meters.headless.measureWindow({ work: Effect.succeed('value') }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              done = true
            }),
          ),
        ),
        { startImmediately: true },
      )
      yield* Effect.yieldNow
      for (let index = 0; index < 29; index++) test.host.tick()
      yield* Effect.yieldNow
      expect(done).toBe(false)
      test.host.tick()
      const result = yield* Fiber.join(window)
      expect(result.result).toBe('value')
      expect(result.measurement.data.framesCaptured).toBe(30)
    }),
  )

  it.effect(
    'accepts serializable copies and rejects modified, duplicate, forged, cross-session and stale handles',
    () =>
      Effect.gen(function* () {
        const test = fixture()
        const scope = yield* Scope.make()
        yield* Scope.provide(test.meters.start, scope)
        const handle = yield* test.meters.headless.beginMeasure
        expect(
          (yield* Effect.flip(
            test.meters.headless.endMeasure({
              handle: { ...handle, startedAtMs: handle.startedAtMs + 1 },
            }),
          )).reason,
        ).toBe('InvalidHandle')
        expect(
          (yield* Effect.flip(
            test.meters.headless.endMeasure({ handle: { ...handle, id: 100000 } }),
          )).reason,
        ).toBe('InvalidHandle')
        expect(
          (yield* Effect.flip(test.meters.headless.endMeasure({ handle, settleFrames: -1 })))
            .reason,
        ).toBe('InvalidOptions')
        const other = fixture()
        yield* other.meters.start
        expect((yield* Effect.flip(other.meters.headless.endMeasure({ handle }))).reason).toBe(
          'WrongSession',
        )
        const copy = {
          _tag: handle._tag,
          sessionId: handle.sessionId,
          generation: handle.generation,
          id: handle.id,
          startedAtMs: handle.startedAtMs,
        }
        yield* test.meters.headless.endMeasure({ handle: copy })
        expect((yield* Effect.flip(test.meters.headless.endMeasure({ handle }))).reason).toBe(
          'AlreadyEnded',
        )
        const stale = yield* test.meters.headless.beginMeasure
        yield* Scope.close(scope, Exit.succeed(undefined))
        expect((yield* test.meters.headless.endMeasure({ handle: stale }))._tag).toBe('Incomplete')
        const next = yield* Scope.make()
        yield* Scope.provide(test.meters.start, next)
        expect(
          (yield* Effect.flip(test.meters.headless.endMeasure({ handle: stale }))).reason,
        ).toBe('StaleGeneration')
        yield* Scope.close(next, Exit.succeed(undefined))
      }),
  )

  it.effect(
    'retains pending calibration, hidden and independent observation-loss reasons after recovery',
    () =>
      Effect.gen(function* () {
        const host = testPlatform()
        let lost = 0
        const frame = makeSeries<FpsValue>({ id: 'frame', label: '', unit: 'fps', capacity: 2500 })
        const loss = makeSource({
          id: 'loss',
          series: makeSeries<number>({ id: 'loss', label: '', unit: 'count', capacity: 1 }),
          cadence: { _tag: 'Event' },
          evidence: { loss: () => lost },
          start: () => Effect.void,
        })
        const meters = makeMeters({
          platform: host.platform,
          sources: [frameSource({ id: 'frame', series: frame }), loss],
        })
        yield* meters.start
        const handle = yield* meters.headless.beginMeasure
        for (let index = 0; index < 110; index++) host.tick()
        host.setVisible(false)
        host.advance(500)
        host.setVisible(true)
        host.tick()
        lost++
        const result = yield* meters.headless.endMeasure({ handle })
        expect(result._tag).toBe('Incomplete')
        if (result._tag === 'Incomplete') {
          expect(result.eligible).toBe(false)
          expect(result.reasons).toEqual(
            expect.arrayContaining(['CalibrationInvalid', 'Hidden', 'ObservationLost']),
          )
        }
      }),
  )

  it.effect('ends hidden settlement promptly and marks stopped and missing-frame collection', () =>
    Effect.gen(function* () {
      const test = fixture()
      const scope = yield* Scope.make()
      yield* Scope.provide(test.meters.start, scope)
      for (let index = 0; index < 110; index++) test.host.tick()
      const handle = yield* test.meters.headless.beginMeasure
      const ending = yield* Effect.forkChild(
        test.meters.headless.endMeasure({ handle, settleFrames: 30 }),
        { startImmediately: true },
      )
      test.host.setVisible(false)
      const hidden = yield* Fiber.join(ending)
      if (hidden._tag === 'Incomplete') expect(hidden.reasons).toContain('Hidden')
      test.host.setVisible(true)
      const stopped = yield* test.meters.headless.beginMeasure
      const settlingHandle = yield* test.meters.headless.beginMeasure
      const stopping = yield* Effect.forkChild(
        test.meters.headless.endMeasure({ handle: settlingHandle, settleFrames: 30 }),
        { startImmediately: true },
      )
      yield* Scope.close(scope, Exit.succeed(undefined))
      const settledOnRelease = yield* Fiber.join(stopping)
      expect(settledOnRelease._tag).toBe('Incomplete')
      if (settledOnRelease._tag === 'Incomplete')
        expect(settledOnRelease.reasons).toContain('Stopped')
      const afterStop = yield* test.meters.headless.endMeasure({ handle: stopped, settleFrames: 1 })
      if (afterStop._tag === 'Incomplete') expect(afterStop.reasons).toContain('Stopped')
      expect((yield* Effect.flip(test.meters.headless.beginMeasure)).reason).toBe('NotRunning')
      const empty = makeMeters({ sources: [], platform: test.host.platform })
      yield* empty.start
      const missing = yield* empty.headless.endMeasure({
        handle: yield* empty.headless.beginMeasure,
      })
      if (missing._tag === 'Incomplete') expect(missing.reasons).toContain('NotConfigured')
    }),
  )

  it.effect('preserves the original failed and interrupted work cause', () =>
    Effect.gen(function* () {
      const test = fixture()
      yield* test.meters.start
      const failure = { _tag: 'WorkFailure', message: 'original failure' }
      const result = yield* Effect.flip(
        test.meters.headless.measureWindow({ work: Effect.fail(failure) }),
      )
      expect(result).toBe(failure)
      const original = yield* Effect.exit(Effect.interrupt)
      const interrupted = yield* Effect.exit(
        test.meters.headless.measureWindow({ work: Effect.interrupt }),
      )
      expect(interrupted).toEqual(original)
      expect(test.host.pending).toBe(1)
    }),
  )
})
