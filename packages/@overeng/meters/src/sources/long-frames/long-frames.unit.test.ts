import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'

import type { BrowserEntry, BrowserEnvironment } from '../../platform/browser.ts'
import { makeSeries } from '../../series/index.ts'
import { testPlatform } from '../../session/_test-platform.ts'
import { makeMeters } from '../../session/index.ts'
import { longFramesSource, type LongFrameValue } from './index.ts'

for (const type of ['long-animation-frame', 'longtask', 'unsupported'] as const) {
  describe(type, () => {
    it.effect('detects capability at acquisition and disconnects on release', () =>
      Effect.gen(function* () {
        const host = testPlatform()
        let reads = 0
        let constructions = 0
        let disconnects = 0
        let callback: ((list: { getEntries: () => readonly BrowserEntry[] }) => void) | undefined
        const observed: string[] = []
        class Observer {
          static supportedEntryTypes =
            type === 'unsupported'
              ? []
              : type === 'long-animation-frame'
                ? [type, 'longtask']
                : [type]
          constructor(notify: (list: { getEntries: () => readonly BrowserEntry[] }) => void) {
            callback = notify
            constructions++
          }
          observe(options: { type: string; buffered: boolean }) {
            observed.push(options.type)
          }
          disconnect() {
            disconnects++
          }
        }
        const browser: BrowserEnvironment = {
          performance: { now: () => 100, timeOrigin: 1000 },
          PerformanceObserver: Observer,
        }
        const series = makeSeries<LongFrameValue>({
          id: 'jank',
          label: 'Jank / long tasks',
          unit: 'ms',
          capacity: 10,
        })
        const source = longFramesSource({
          id: 'jank',
          series,
          browser: () => {
            reads++
            return browser
          },
        })
        const meters = makeMeters({ sources: [source], platform: host.platform })
        expect(reads).toBe(0)
        expect(constructions).toBe(0)
        const scope = yield* Scope.make()
        yield* Scope.provide(meters.start, scope)
        const view = meters.store.read({ series })
        if (type === 'unsupported') {
          expect(view.latest).toEqual({ _tag: 'Unavailable', atMs: 0, reason: 'Unsupported' })
          expect(constructions).toBe(0)
        } else {
          expect(observed).toEqual([type])
          host.advance(200)
          callback?.({
            getEntries: () => [
              {
                entryType: type,
                startTime: 50,
                duration: 80,
                blockingDuration: 20,
                renderStart: 70,
              },
            ],
          })
          expect(view.latest).toEqual({
            _tag: 'Value',
            atMs: 200,
            value:
              type === 'long-animation-frame'
                ? {
                    _tag: 'LoAF',
                    startedAtMs: 150,
                    durationMs: 80,
                    blockingDurationMs: 20,
                    renderStartMs: 170,
                  }
                : { _tag: 'LongTask', startedAtMs: 150, durationMs: 80 },
          })
        }
        const revision = view.revision
        yield* Scope.close(scope, Exit.succeed(undefined))
        expect(disconnects).toBe(type === 'unsupported' ? 0 : 1)
        callback?.({ getEntries: () => [{ entryType: type, startTime: 0, duration: 100 }] })
        expect(view.revision).toBe(revision)
        expect(host.requests).toBe(0)
      }),
    )
  })
}

describe('no PerformanceObserver', () => {
  it.effect('reports Unsupported instead of a zero duration', () =>
    Effect.gen(function* () {
      const series = makeSeries<LongFrameValue>({
        id: 'jank',
        label: 'Jank',
        unit: 'ms',
        capacity: 5,
      })
      const meters = makeMeters({
        sources: [longFramesSource({ id: 'jank', series, browser: () => ({}) })],
        platform: testPlatform().platform,
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* meters.start
          expect(meters.store.read({ series }).latest?._tag).toBe('Unavailable')
        }),
      )
    }),
  )
})

describe('observer acquisition failure', () => {
  it.effect('preserves the cause and disconnects an observer whose observe call fails', () =>
    Effect.gen(function* () {
      let disconnects = 0
      const cause = new Error('Observer installation failed')
      class Observer {
        static supportedEntryTypes = ['longtask']
        observe(_options: { type: string; buffered: boolean }) {
          throw cause
        }
        disconnect() {
          disconnects++
        }
      }
      const series = makeSeries<LongFrameValue>({
        id: 'jank',
        label: 'Long tasks',
        unit: 'ms',
        capacity: 5,
      })
      const meters = makeMeters({
        sources: [
          longFramesSource({
            id: 'jank',
            series,
            browser: () => ({
              PerformanceObserver: Observer,
              performance: { now: () => 0, timeOrigin: 1000 },
            }),
          }),
        ],
        platform: testPlatform().platform,
      })
      const failure = yield* Effect.flip(Effect.scoped(meters.start))
      expect(failure.cause).toBe(cause)
      expect(failure.reason).toBe('AcquisitionFailed')
      expect(disconnects).toBe(1)
    }),
  )
})
