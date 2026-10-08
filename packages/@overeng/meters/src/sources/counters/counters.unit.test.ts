import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'

import { makeSeries, type NumberValue } from '../../series/index.ts'
import { testPlatform } from '../../session/_test-platform.ts'
import { makeMeters } from '../../session/index.ts'
import {
  counterSource,
  counterToken,
  gaugeSource,
  gaugeToken,
  makeInstrumentation,
} from './index.ts'

describe('typed instrumentation source entry', () => {
  it.effect('re-exports live non-destructive counters/gauges and removes both subscriptions', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const counter = counterToken({ id: 'work' })
      const gauge = gaugeToken({ id: 'queue' })
      const instrumentation = makeInstrumentation({ counters: [counter], gauges: [gauge] })
      const countSeries = makeSeries<NumberValue>({
        id: 'work',
        label: 'Work',
        unit: 'count',
        capacity: 10,
      })
      const gaugeSeries = makeSeries<NumberValue>({
        id: 'queue',
        label: 'Queue',
        unit: 'count',
        capacity: 10,
      })
      const meters = makeMeters({
        platform: host.platform,
        sources: [
          counterSource({ id: 'work', series: countSeries, instrumentation, token: counter }),
          gaugeSource({ id: 'queue', series: gaugeSeries, instrumentation, token: gauge }),
        ],
      })
      const scope = yield* Scope.make()
      yield* Scope.provide(meters.start, scope)
      expect(meters.store.read({ series: countSeries }).latest).toEqual({
        _tag: 'Value',
        atMs: 0,
        value: { _tag: 'Number', value: 0 },
      })
      instrumentation.counter({ token: counter }).add({ by: 2 })
      instrumentation.gauge({ token: gauge }).set({ value: 3 })
      expect(instrumentation.counter({ token: counter }).read()).toBe(2)
      expect(instrumentation.counter({ token: counter }).read()).toBe(2)
      expect(meters.store.read({ series: gaugeSeries }).latest).toEqual({
        _tag: 'Value',
        atMs: 0,
        value: { _tag: 'Number', value: 3 },
      })
      yield* Scope.close(scope, Exit.succeed(undefined))
      const revision = meters.store.getRevision()
      instrumentation.counter({ token: counter }).add({ by: 1 })
      instrumentation.gauge({ token: gauge }).set({ value: 4 })
      expect(meters.store.getRevision()).toBe(revision)
    }),
  )
})
