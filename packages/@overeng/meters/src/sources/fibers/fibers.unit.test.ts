import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Metric, Scope } from 'effect'
import { TestClock } from 'effect/testing'

import { makeSeries } from '../../series/index.ts'
import { testPlatform } from '../../session/_test-platform.ts'
import { makeMeters } from '../../session/index.ts'
import { fibersSource, runtimeMetricContext, type Fibers } from './index.ts'

const series = () =>
  makeSeries<Fibers>({ id: 'fibers', label: 'active child fibers', unit: 'count', capacity: 10 })

describe('host-enabled child fiber metric', () => {
  it.effect('reports unavailable without enabling a dormant metric', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const values = series()
      const context = yield* runtimeMetricContext
      expect(context.runtimeMetricsEnabled()).toBe(false)
      const meters = makeMeters({
        platform: host.platform,
        sources: [
          fibersSource({ id: 'fibers', series: values, everyMs: 250, metricContext: context }),
        ],
      })
      const scope = yield* Scope.make()
      yield* Scope.provide(meters.start, scope)
      yield* Effect.yieldNow
      expect(meters.store.read({ series: values }).latest).toEqual({
        _tag: 'Unavailable',
        atMs: 0,
        reason: 'NotConfigured',
      })
      expect(yield* Metric.FiberRuntimeMetrics).toBeUndefined()
      yield* Scope.close(scope, Exit.succeed(undefined))
      const revision = meters.store.getRevision()
      yield* TestClock.adjust(1000)
      expect(meters.store.getRevision()).toBe(revision)
      expect(host.observers).toBe(0)
    }).pipe(Metric.disableRuntimeMetrics),
  )

  it.effect('reads the actual tagged registry gauge when the host enables metrics', () =>
    Effect.gen(function* () {
      // Mark the deterministic clock as driven before measuring: its first sleep otherwise
      // forks a warning fiber after the first sample, changing the real runtime gauge.
      yield* TestClock.adjust(0)
      const context = yield* runtimeMetricContext
      expect(context.runtimeMetricsEnabled()).toBe(true)
      const before = context.readActiveChildFibers()
      const child = yield* Effect.forkChild(Effect.never)
      expect(context.readActiveChildFibers()).toBe(before + 1)
      const host = testPlatform()
      const values = series()
      const meters = makeMeters({
        platform: host.platform,
        sources: [
          fibersSource({ id: 'fibers', series: values, everyMs: 250, metricContext: context }),
        ],
      })
      const scope = yield* Scope.make()
      yield* Scope.provide(meters.start, scope)
      yield* Effect.yieldNow
      const sample = meters.store.read({ series: values }).latest
      expect(sample?._tag).toBe('Value')
      if (sample?._tag === 'Value') {
        expect(sample.value.activeChildFibers).toBe(context.readActiveChildFibers())
        expect(sample.value.activeChildFibers).toBeGreaterThanOrEqual(before + 1)
      }
      yield* Scope.close(scope, Exit.succeed(undefined))
      yield* Fiber.interrupt(child)
      expect(context.readActiveChildFibers()).toBe(before)
    }).pipe(
      Metric.enableRuntimeMetrics,
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.provideService(Metric.CurrentMetricAttributes, { host: 'test' }),
    ),
  )
})
