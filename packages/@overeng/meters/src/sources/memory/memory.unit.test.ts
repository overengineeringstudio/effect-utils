import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Scope } from 'effect'
import { TestClock } from 'effect/testing'

import type { BrowserEnvironment } from '../../platform/browser.ts'
import { makeSeries } from '../../series/index.ts'
import { testPlatform } from '../../session/_test-platform.ts'
import { makeMeters } from '../../session/index.ts'
import { appMemoryProbe, heapSource, type AppMemory, type HeapMemory } from './index.ts'

describe('memory source availability', () => {
  it.effect('keeps approximate JS heap distinct from explicitly probed app memory', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      let reads = 0
      let probes = 0
      const browser: BrowserEnvironment = {
        crossOriginIsolated: true,
        isSecureContext: true,
        performance: {
          now: () => 0,
          timeOrigin: 1000,
          memory: { usedJSHeapSize: 10, totalJSHeapSize: 20, jsHeapSizeLimit: 100 },
          measureUserAgentSpecificMemory: () => {
            probes++
            return Promise.resolve({ bytes: 400 })
          },
        },
      }
      const resolveBrowser = () => {
        reads++
        return browser
      }
      const heap = makeSeries<HeapMemory>({
        id: 'heap',
        label: 'JS heap (approximate)',
        unit: 'bytes',
        capacity: 5,
      })
      const app = makeSeries<AppMemory>({
        id: 'app-memory',
        label: 'App memory',
        unit: 'bytes',
        capacity: 5,
      })
      const probe = appMemoryProbe({ id: 'app-memory', series: app, browser: resolveBrowser })
      const meters = makeMeters({
        sources: [
          heapSource({ id: 'heap', series: heap, everyMs: 1000, browser: resolveBrowser }),
          probe.source,
        ],
        platform: host.platform,
      })
      expect(reads).toBe(0)
      expect(probes).toBe(0)
      const scope = yield* Scope.make()
      yield* Scope.provide(meters.start, scope)
      yield* Effect.yieldNow
      expect(probes).toBe(0)
      expect(meters.store.read({ series: app }).length).toBe(0)
      expect(meters.store.read({ series: heap }).latest).toEqual({
        _tag: 'Value',
        atMs: 0,
        value: {
          _tag: 'HeapMemory',
          approximate: true,
          usedBytes: 10,
          totalBytes: 20,
          limitBytes: 100,
        },
      })
      expect(yield* probe.probe).toEqual({
        _tag: 'Value',
        atMs: 0,
        value: { _tag: 'AppMemory', bytes: 400 },
      })
      expect(probes).toBe(1)
      yield* Scope.close(scope, Exit.succeed(undefined))
      const revision = meters.store.read({ series: heap }).revision
      yield* TestClock.adjust(2000)
      expect(meters.store.read({ series: heap }).revision).toBe(revision)
      expect(yield* probe.probe).toEqual({ _tag: 'Unavailable', atMs: 0, reason: 'NotConfigured' })
    }),
  )

  it.effect('reports unsupported heap once without polling', () =>
    Effect.gen(function* () {
      let reads = 0
      const heap = makeSeries<HeapMemory>({
        id: 'heap',
        label: 'JS heap',
        unit: 'bytes',
        capacity: 5,
      })
      const meters = makeMeters({
        sources: [
          heapSource({
            id: 'heap',
            series: heap,
            everyMs: 1000,
            browser: () => {
              reads++
              return {}
            },
          }),
        ],
        platform: testPlatform().platform,
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* meters.start
          expect(meters.store.read({ series: heap }).latest).toEqual({
            _tag: 'Unavailable',
            atMs: 0,
            reason: 'Unsupported',
          })
          yield* TestClock.adjust(5000)
          expect(reads).toBe(1)
          expect(meters.store.read({ series: heap }).length).toBe(1)
        }),
      )
    }),
  )

  for (const capability of [
    'not-isolated',
    'not-secure',
    'unsupported',
    'permission-denied',
    'failed',
  ] as const) {
    it.effect(`reports ${capability} without substituting heap`, () =>
      Effect.gen(function* () {
        let calls = 0
        const browser: BrowserEnvironment = {
          crossOriginIsolated: capability !== 'not-isolated',
          isSecureContext: capability !== 'not-secure',
          performance: {
            now: () => 0,
            timeOrigin: 1000,
            memory: { usedJSHeapSize: 10, totalJSHeapSize: 20, jsHeapSizeLimit: 100 },
            ...(capability === 'unsupported'
              ? {}
              : {
                  measureUserAgentSpecificMemory: () => {
                    calls++
                    const error = new Error('Measurement rejected')
                    error.name = capability === 'permission-denied' ? 'SecurityError' : 'Error'
                    return Promise.reject(error)
                  },
                }),
          },
        }
        const series = makeSeries<AppMemory>({
          id: 'app-memory',
          label: 'App memory',
          unit: 'bytes',
          capacity: 5,
        })
        const probe = appMemoryProbe({ id: 'app-memory', series, browser: () => browser })
        const meters = makeMeters({ sources: [probe.source], platform: testPlatform().platform })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* meters.start
            expect(calls).toBe(0)
            const sample = yield* probe.probe
            expect(sample).toEqual({
              _tag: 'Unavailable',
              atMs: 0,
              reason:
                capability === 'not-isolated'
                  ? 'NotIsolated'
                  : capability === 'permission-denied'
                    ? 'PermissionDenied'
                    : capability === 'failed'
                      ? 'MeasurementFailed'
                      : 'Unsupported',
            })
            expect(calls).toBe(
              capability === 'failed' || capability === 'permission-denied' ? 1 : 0,
            )
            expect(meters.store.read({ series }).latest).toEqual(sample)
          }),
        )
      }),
    )
  }

  it.effect('shares concurrent probes and prevents publication after release', () =>
    Effect.gen(function* () {
      let calls = 0
      const measurement = Promise.withResolvers<{ bytes: number }>()
      const started = Promise.withResolvers<void>()
      const series = makeSeries<AppMemory>({
        id: 'app-memory',
        label: 'App memory',
        unit: 'bytes',
        capacity: 5,
      })
      const probe = appMemoryProbe({
        id: 'app-memory',
        series,
        browser: () => ({
          crossOriginIsolated: true,
          isSecureContext: true,
          performance: {
            now: () => 0,
            timeOrigin: 1000,
            measureUserAgentSpecificMemory: () => {
              calls++
              started.resolve()
              return measurement.promise
            },
          },
        }),
      })
      const meters = makeMeters({ sources: [probe.source], platform: testPlatform().platform })
      const scope = yield* Scope.make()
      yield* Scope.provide(meters.start, scope)
      const first = yield* Effect.forkChild(probe.probe)
      const second = yield* Effect.forkChild(probe.probe)
      yield* Effect.promise(() => started.promise)
      yield* Effect.yieldNow
      expect(calls).toBe(1)
      measurement.resolve({ bytes: 200 })
      expect(yield* Fiber.join(first)).toEqual(yield* Fiber.join(second))
      expect(meters.store.read({ series }).length).toBe(1)
      yield* Scope.close(scope, Exit.succeed(undefined))
      expect(yield* probe.probe).toEqual({ _tag: 'Unavailable', atMs: 0, reason: 'NotConfigured' })
      expect(calls).toBe(1)
    }),
  )

  it.effect('does not publish an outstanding probe into a closed lease', () =>
    Effect.gen(function* () {
      const measurement = Promise.withResolvers<{ bytes: number }>()
      const started = Promise.withResolvers<void>()
      const series = makeSeries<AppMemory>({
        id: 'app-memory',
        label: 'App memory',
        unit: 'bytes',
        capacity: 5,
      })
      const probe = appMemoryProbe({
        id: 'app-memory',
        series,
        browser: () => ({
          crossOriginIsolated: true,
          isSecureContext: true,
          performance: {
            now: () => 0,
            timeOrigin: 1000,
            measureUserAgentSpecificMemory: () => {
              started.resolve()
              return measurement.promise
            },
          },
        }),
      })
      const meters = makeMeters({ sources: [probe.source], platform: testPlatform().platform })
      const scope = yield* Scope.make()
      yield* Scope.provide(meters.start, scope)
      const pending = yield* Effect.forkChild(probe.probe)
      yield* Effect.promise(() => started.promise)
      yield* Scope.close(scope, Exit.succeed(undefined))
      measurement.resolve({ bytes: 200 })
      yield* Fiber.join(pending)
      expect(meters.store.read({ series }).length).toBe(0)
    }),
  )
})
