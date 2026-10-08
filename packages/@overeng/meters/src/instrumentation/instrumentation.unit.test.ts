import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Schema, Scope } from 'effect'

import { makeSeries, type NumberValue } from '../series/index.ts'
import { testPlatform } from '../session/_test-platform.ts'
import { makeMeters, makeSource } from '../session/index.ts'
import {
  counterSource,
  counterToken,
  gaugeSource,
  gaugeToken,
  makeInstrumentation,
  instrumentationEvidence,
} from './index.ts'

describe('typed instruments', () => {
  it.effect.prop(
    'adds finite nonnegative increments without destructive reads',
    [
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000 })),
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000 })),
    ],
    ([first, second]) =>
      Effect.sync(() => {
        const token = counterToken({ id: 'counter' })
        const service = makeInstrumentation({ counters: [token], gauges: [] })
        const counter = service.counter({ token })
        expect(counter.read()).toBe(0)
        counter.add({ by: first })
        counter.add({ by: second })
        expect(counter.read()).toBe(first + second)
        expect(counter.read()).toBe(first + second)
        expect(() => counter.add({ by: -1 })).toThrow()
        expect(() => counter.add({ by: Infinity })).toThrow()
      }),
  )
  it.effect('keeps event collectors scoped and cumulative totals across leases', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const counter = counterToken({ id: 'counter' })
      const gauge = gaugeToken({ id: 'gauge' })
      const service = makeInstrumentation({ counters: [counter], gauges: [gauge] })
      const count = makeSeries<NumberValue>({
        id: 'counter',
        label: '',
        unit: 'count',
        capacity: 10,
      })
      const current = makeSeries<NumberValue>({
        id: 'gauge',
        label: '',
        unit: 'count',
        capacity: 10,
      })
      const meters = makeMeters({
        platform: host.platform,
        sources: [
          counterSource({ id: 'counter', series: count, instrumentation: service, token: counter }),
          gaugeSource({ id: 'gauge', series: current, instrumentation: service, token: gauge }),
        ],
      })
      const first = yield* Scope.make()
      yield* Scope.provide(meters.start, first)
      expect(meters.store.read({ series: count }).latest).toMatchObject({
        _tag: 'Value',
        value: { _tag: 'Number', value: 0 },
      })
      service.counter({ token: counter }).add({ by: 5 })
      service.gauge({ token: gauge }).set({ value: -5 })
      expect(meters.headless.snapshot().counters).toEqual({ counter: 5 })
      yield* Scope.close(first, Exit.succeed(undefined))
      const length = meters.store.read({ series: count }).length
      service.counter({ token: counter }).add({ by: 2 })
      expect(meters.store.read({ series: count }).length).toBe(length)
      const second = yield* Scope.make()
      yield* Scope.provide(meters.start, second)
      expect(meters.store.read({ series: count }).latest).toMatchObject({
        _tag: 'Value',
        value: { value: 7 },
      })
      expect(meters.store.read({ series: current }).latest).toMatchObject({
        _tag: 'Value',
        value: { value: -5 },
      })
      yield* Scope.close(second, Exit.succeed(undefined))
    }),
  )
  it.effect('rejects undeclared tokens, duplicate identities and nonfinite gauge values', () =>
    Effect.sync(() => {
      const counter = counterToken({ id: 'same' })
      const gauge = gaugeToken({ id: 'same' })
      expect(() => makeInstrumentation({ counters: [counter], gauges: [gauge] })).toThrow()
      const service = makeInstrumentation({ counters: [], gauges: [gauge] })
      expect(() => service.counter({ token: counter })).toThrow()
      expect(() => service.gauge({ token: gauge }).set({ value: NaN })).toThrow()
    }),
  )
  it.effect('rejects colliding instrument IDs across separate registries before acquisition', () =>
    Effect.sync(() => {
      const host = testPlatform()
      const first = counterToken({ id: 'shared' })
      const second = gaugeToken({ id: 'shared' })
      const firstRegistry = makeInstrumentation({ counters: [first], gauges: [] })
      const secondRegistry = makeInstrumentation({ counters: [], gauges: [second] })
      const sources = [
        counterSource({
          id: 'one',
          series: makeSeries<NumberValue>({ id: 'one', label: '', unit: 'count', capacity: 1 }),
          instrumentation: firstRegistry,
          token: first,
        }),
        gaugeSource({
          id: 'two',
          series: makeSeries<NumberValue>({ id: 'two', label: '', unit: 'count', capacity: 1 }),
          instrumentation: secondRegistry,
          token: second,
        }),
      ]
      expect(() => makeMeters({ sources, platform: host.platform })).toThrow('Duplicate instrument')
      expect(host.observers).toBe(0)
      expect(host.requests).toBe(0)
    }),
  )
  it.effect('binds composed event-source brackets to the same counter registry', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const token = counterToken({ id: 'commits' })
      const instrumentation = makeInstrumentation({ counters: [token], gauges: [] })
      const source = makeSource({
        id: 'commits',
        series: makeSeries<NumberValue>({ id: 'commits', label: '', unit: 'count', capacity: 1 }),
        cadence: { _tag: 'Event' },
        evidence: instrumentationEvidence({ instrumentation }),
        start: () => Effect.void,
      })
      const meters = makeMeters({ sources: [source], platform: host.platform })
      yield* meters.start
      const before = meters.headless.snapshot()
      const handle = yield* meters.headless.beginMeasure
      instrumentation.counter({ token }).add({ by: 3 })
      host.advance(1)
      expect(meters.headless.snapshot()).not.toBe(before)
      expect(meters.headless.snapshot().counters).toEqual({ commits: 3 })
      expect((yield* meters.headless.endMeasure({ handle })).data.counterDelta).toEqual({
        commits: 3,
      })
    }),
  )
})
