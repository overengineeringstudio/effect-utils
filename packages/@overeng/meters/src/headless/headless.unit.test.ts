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
import { MeasureError, MeasureResult } from './index.ts'

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
        const bracket = yield* test.meters.headless.measurement
        test.instrumentation.counter({ token: test.token }).add({ by: increment })
        for (let index = 0; index < 4; index++)
          test.instrumentation.counter({ token: test.token }).add({ by: 0 })
        test.instrumentation.gauge({ token: test.gauge }).set({ value: -4 })
        test.host.tick()
        test.host.tick()
        const measurement = yield* bracket.end()
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
      const bracket = yield* meters.headless.measurement
      added = true
      test.host.tick()
      expect((yield* bracket.end()).data.counterDelta).toEqual({ late: 7 })
    }),
  )

  it.effect('defaults split settlement to zero and work settlement to thirty actual frames', () =>
    Effect.gen(function* () {
      const test = fixture()
      yield* test.meters.start
      for (let index = 0; index < 110; index++) test.host.tick()
      const bracket = yield* test.meters.headless.measurement
      test.host.tick()
      expect((yield* bracket.end()).data.framesCaptured).toBe(1)
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

  it.effect('validates options before claiming and ends exactly once', () =>
    Effect.gen(function* () {
      const test = fixture()
      yield* test.meters.start
      const bracket = yield* test.meters.headless.measurement
      for (const settleFrames of [-1, 0.5, NaN, Infinity]) {
        expect((yield* Effect.flip(bracket.end({ settleFrames }))).reason).toBe('InvalidOptions')
      }
      yield* bracket.end()
      expect((yield* Effect.flip(bracket.end())).reason).toBe('AlreadyEnded')
    }),
  )

  it.effect('rejects a concurrent end while the first claimant is settling', () =>
    Effect.gen(function* () {
      const test = fixture()
      yield* test.meters.start
      for (let index = 0; index < 110; index++) test.host.tick()
      const bracket = yield* test.meters.headless.measurement
      const first = yield* Effect.forkChild(bracket.end({ settleFrames: 2 }), {
        startImmediately: true,
      })
      expect((yield* Effect.flip(bracket.end())).reason).toBe('AlreadyEnded')
      test.host.tick()
      test.host.tick()
      expect((yield* Fiber.join(first))._tag).toBe('Complete')
      expect((yield* Effect.flip(bracket.end())).reason).toBe('AlreadyEnded')
    }),
  )

  it.effect('abandons escaped resources when their owning scope closes', () =>
    Effect.gen(function* () {
      const test = fixture()
      yield* test.meters.start
      const bracket = yield* Effect.scoped(test.meters.headless.measurement)
      expect((yield* Effect.flip(bracket.end())).reason).toBe('ScopeClosed')
      expect(test.host.pending).toBe(1)
    }),
  )

  it.effect('closing the owning scope cancels pending settlement promptly', () =>
    Effect.gen(function* () {
      const test = fixture()
      yield* test.meters.start
      const owner = yield* Scope.make()
      const bracket = yield* Scope.provide(test.meters.headless.measurement, owner)
      const ending = yield* Effect.forkChild(bracket.end({ settleFrames: 30 }), {
        startImmediately: true,
      })
      yield* Scope.close(owner, Exit.succeed(undefined))
      expect((yield* Effect.flip(Fiber.join(ending))).reason).toBe('ScopeClosed')
      expect((yield* Effect.flip(bracket.end())).reason).toBe('AlreadyEnded')
      expect(test.host.pending).toBe(1)
    }),
  )

  it.effect('restart invalidates outstanding resources without changing delivered results', () =>
    Effect.gen(function* () {
      const test = fixture()
      const lease = yield* Scope.make()
      yield* Scope.provide(test.meters.start, lease)
      const delivered = yield* (yield* test.meters.headless.measurement).end()
      const outstanding = yield* test.meters.headless.measurement
      yield* Scope.close(lease, Exit.succeed(undefined))
      yield* test.meters.start
      expect((yield* Effect.flip(outstanding.end())).reason).toBe('StaleGeneration')
      expect(delivered._tag).toBe('Incomplete')
      yield* (yield* test.meters.headless.measurement).end()
    }),
  )

  it.effect('interrupted settlement remains single shot', () =>
    Effect.gen(function* () {
      const test = fixture()
      yield* test.meters.start
      const bracket = yield* test.meters.headless.measurement
      const ending = yield* Effect.forkChild(bracket.end({ settleFrames: 30 }), {
        startImmediately: true,
      })
      yield* Fiber.interrupt(ending)
      expect((yield* Effect.flip(bracket.end())).reason).toBe('AlreadyEnded')
      expect(test.host.pending).toBe(1)
    }),
  )

  it.effect('invalid work settlement does not execute work', () =>
    Effect.gen(function* () {
      const test = fixture()
      yield* test.meters.start
      let executed = false
      const error = yield* Effect.flip(
        test.meters.headless.measureWindow({
          work: Effect.sync(() => {
            executed = true
          }),
          settleFrames: -1,
        }),
      )
      expect(error.reason).toBe('InvalidOptions')
      expect(executed).toBe(false)
    }),
  )

  it.effect('releases completed resources within a long-lived parent scope', () =>
    Effect.gen(function* () {
      const test = fixture()
      yield* test.meters.start
      const parent = yield* Scope.make()
      expect(parent.state._tag).toBe('Empty')
      for (let index = 0; index < 200; index++) {
        const bracket = yield* Scope.provide(test.meters.headless.measurement, parent)
        expect(parent.state._tag).toBe('Open')
        yield* bracket.end()
        expect(parent.state._tag).toBe('Empty')
        expect((yield* Effect.flip(bracket.end())).reason).toBe('AlreadyEnded')
      }
      yield* Scope.close(parent, Exit.succeed(undefined))
      expect(test.host.pending).toBe(1)
    }),
  )

  it.effect('freezes stopped counter evidence before collector teardown', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      let total = 0
      const source = makeSource({
        id: 'released-counter',
        series: makeSeries<number>({
          id: 'released-counter',
          label: '',
          unit: 'count',
          capacity: 1,
        }),
        cadence: { _tag: 'Event' },
        evidence: { counters: () => ({ released: total }) },
        start: () =>
          Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              total = 0
            }),
          ),
      })
      const meters = makeMeters({ platform: host.platform, sources: [source] })
      const lease = yield* Scope.make()
      yield* Scope.provide(meters.start, lease)
      const open = yield* meters.headless.measurement
      const pending = yield* meters.headless.measurement
      total = 7
      const ending = yield* Effect.forkChild(pending.end({ settleFrames: 30 }), {
        startImmediately: true,
      })
      yield* Scope.close(lease, Exit.succeed(undefined))
      expect(total).toBe(0)
      for (const result of [yield* Fiber.join(ending), yield* open.end()]) {
        expect(result._tag).toBe('Incomplete')
        expect(result.data.counterDelta).toEqual({ released: 7 })
        if (result._tag === 'Incomplete') expect(result.reasons).toContain('Stopped')
      }
    }),
  )

  it.effect('releasing a non-last lease does not invalidate measurements', () =>
    Effect.gen(function* () {
      const test = fixture()
      yield* test.meters.start
      const extra = yield* Scope.make()
      yield* Scope.provide(test.meters.start, extra)
      for (let index = 0; index < 110; index++) test.host.tick()
      const bracket = yield* test.meters.headless.measurement
      yield* Scope.close(extra, Exit.succeed(undefined))
      test.host.tick()
      expect((yield* bracket.end())._tag).toBe('Complete')
    }),
  )

  it.effect('pending stopped settlement cannot read counters from a restarted generation', () =>
    Effect.gen(function* () {
      const test = fixture()
      const lease = yield* Scope.make()
      yield* Scope.provide(test.meters.start, lease)
      for (let index = 0; index < 110; index++) test.host.tick()
      const bracket = yield* test.meters.headless.measurement
      test.instrumentation.counter({ token: test.token }).add({ by: 3 })
      const ending = yield* Effect.forkChild(bracket.end({ settleFrames: 30 }), {
        startImmediately: true,
      })
      yield* Scope.close(lease, Exit.succeed(undefined))
      yield* test.meters.start
      test.instrumentation.counter({ token: test.token }).add({ by: 100 })
      const stopped = yield* Fiber.join(ending)
      expect(stopped._tag).toBe('Incomplete')
      expect(stopped.data.counterDelta).toEqual({ jobs: 3 })
      if (stopped._tag === 'Incomplete') expect(stopped.reasons).toContain('Stopped')
    }),
  )

  it.effect('round trips complete, incomplete and tagged error wire schemas', () =>
    Effect.gen(function* () {
      const test = fixture()
      yield* test.meters.start
      const incomplete = yield* (yield* test.meters.headless.measurement).end()
      expect(incomplete._tag).toBe('Incomplete')
      for (let index = 0; index < 110; index++) test.host.tick()
      const bracket = yield* test.meters.headless.measurement
      test.host.tick()
      const complete = yield* bracket.end()
      expect(complete._tag).toBe('Complete')
      for (const result of [complete, incomplete]) {
        const wire = yield* Schema.encodeEffect(MeasureResult)(result)
        expect(yield* Schema.decodeEffect(MeasureResult)(wire)).toEqual(result)
        expect(() =>
          Schema.decodeUnknownSync(MeasureResult)({
            ...wire,
            eligible: !wire.eligible,
          }),
        ).toThrow()
        expect(() =>
          Schema.decodeUnknownSync(MeasureResult)({
            ...wire,
            data: { ...wire.data, durationMs: Infinity },
          }),
        ).toThrow()
        expect(() =>
          Schema.decodeUnknownSync(MeasureResult)({
            ...wire,
            data: { ...wire.data, counterDelta: { invalid: NaN } },
          }),
        ).toThrow()
      }
      expect(() =>
        Schema.decodeUnknownSync(MeasureResult)({
          ...Schema.encodeSync(MeasureResult)(incomplete),
          reasons: [],
        }),
      ).toThrow()
      for (const reason of [
        'NotRunning',
        'StaleGeneration',
        'AlreadyEnded',
        'ScopeClosed',
        'InvalidOptions',
      ] as const) {
        const error = new MeasureError({ reason, message: `Measurement failed: ${reason}` })
        const decoded = yield* Schema.decodeEffect(MeasureError)(
          yield* Schema.encodeEffect(MeasureError)(error),
        )
        expect(decoded).toBeInstanceOf(MeasureError)
        expect(decoded.reason).toBe(reason)
        expect(decoded.message).toBe(error.message)
      }
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
        const bracket = yield* meters.headless.measurement
        for (let index = 0; index < 110; index++) host.tick()
        host.setVisible(false)
        host.advance(500)
        host.setVisible(true)
        host.tick()
        lost++
        const result = yield* bracket.end()
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
      const bracket = yield* test.meters.headless.measurement
      const ending = yield* Effect.forkChild(bracket.end({ settleFrames: 30 }), {
        startImmediately: true,
      })
      test.host.setVisible(false)
      const hidden = yield* Fiber.join(ending)
      if (hidden._tag === 'Incomplete') expect(hidden.reasons).toContain('Hidden')
      test.host.setVisible(true)
      const stopped = yield* test.meters.headless.measurement
      const settling = yield* test.meters.headless.measurement
      const stopping = yield* Effect.forkChild(settling.end({ settleFrames: 30 }), {
        startImmediately: true,
      })
      yield* Scope.close(scope, Exit.succeed(undefined))
      const settledOnRelease = yield* Fiber.join(stopping)
      expect(settledOnRelease._tag).toBe('Incomplete')
      if (settledOnRelease._tag === 'Incomplete')
        expect(settledOnRelease.reasons).toContain('Stopped')
      const afterStop = yield* stopped.end({ settleFrames: 1 })
      if (afterStop._tag === 'Incomplete') expect(afterStop.reasons).toContain('Stopped')
      expect((yield* Effect.flip(test.meters.headless.measurement)).reason).toBe('NotRunning')
      const empty = makeMeters({ sources: [], platform: test.host.platform })
      yield* empty.start
      const missing = yield* (yield* empty.headless.measurement).end()
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
      const defect = new Error('original defect')
      expect(
        yield* Effect.exit(test.meters.headless.measureWindow({ work: Effect.die(defect) })),
      ).toEqual(yield* Effect.exit(Effect.die(defect)))
      const original = yield* Effect.exit(Effect.interrupt)
      const interrupted = yield* Effect.exit(
        test.meters.headless.measureWindow({ work: Effect.interrupt }),
      )
      expect(interrupted).toEqual(original)
      expect(test.host.pending).toBe(1)
    }),
  )
})
