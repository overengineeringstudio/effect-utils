import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'

import type { BrowserEntry, BrowserEnvironment } from '../../platform/browser.ts'
import { makeSeries, type SeriesView } from '../../series/index.ts'
import { testPlatform } from '../../session/_test-platform.ts'
import { makeMeters } from '../../session/index.ts'
import { userTimingSource, type UserTimingFilter, type UserTimingValue } from './index.ts'

type Notify = (list: { getEntries: () => readonly BrowserEntry[] }) => void

const fixture = (options: { readonly filter: UserTimingFilter; readonly supported?: boolean }) => {
  const host = testPlatform()
  const state = {
    constructions: 0,
    disconnects: 0,
    observed: [] as string[],
    buffer: [] as BrowserEntry[],
  }
  const callbacks: Notify[] = []
  class Observer {
    static supportedEntryTypes = options.supported === false ? ['longtask'] : ['mark', 'measure']
    readonly notify: Notify
    constructor(notify: Notify) {
      this.notify = notify
      state.constructions++
      callbacks.push(notify)
    }
    observe(observeOptions: { type: string; buffered: boolean }) {
      state.observed.push(`${observeOptions.type}:${observeOptions.buffered}`)
      // A buffered observer receives every earlier entry, as browsers do.
      if (observeOptions.buffered === true && state.buffer.length > 0) {
        const entries = [...state.buffer]
        this.notify({ getEntries: () => entries })
      }
    }
    disconnect() {
      state.disconnects++
    }
  }
  const browser: BrowserEnvironment = {
    // performance.now() trails the session clock by 1000 ms.
    performance: { now: () => host.platform.now() - 1000, timeOrigin: 0 },
    PerformanceObserver: Observer,
  }
  const series = makeSeries<UserTimingValue>({
    id: 'fractal.timing',
    label: 'Fractal timings',
    unit: 'ms',
    capacity: 16,
  })
  const meters = makeMeters({
    sources: [
      userTimingSource({
        id: 'fractal.timing',
        series,
        filter: options.filter,
        browser: () => browser,
      }),
    ],
    platform: host.platform,
  })
  const measure = (name: string, startTime: number, duration: number): BrowserEntry => {
    const entry: BrowserEntry = { entryType: 'measure', name, startTime, duration }
    state.buffer.push(entry)
    return entry
  }
  const deliver = (entries: readonly BrowserEntry[]) =>
    callbacks.at(-1)?.({ getEntries: () => entries })
  return { host, state, meters, series, measure, deliver }
}

const durations = (view: SeriesView<UserTimingValue>): number[] =>
  Array.from({ length: view.length }, (_, index) => view.at(index)).flatMap((sample) =>
    sample?._tag === 'Value' ? [sample.value.durationMs] : [],
  )

describe('userTimingSource', () => {
  it.effect('dates matching measures at delivery and keeps their true times', () =>
    Effect.gen(function* () {
      const f = fixture({ filter: { _tag: 'Prefix', prefix: 'fractal:' } })
      f.host.advance(2000)
      // Before acquisition: buffered delivery counts it once.
      f.measure('fractal:sidebar_interactive', 200, 300)
      const scope = yield* Scope.make()
      yield* Scope.provide(f.meters.start, scope)
      expect(f.state.observed).toEqual(['measure:true'])
      const view = f.meters.store.read({ series: f.series })
      expect(view.latest).toEqual({
        _tag: 'Value',
        atMs: 2000,
        value: {
          _tag: 'UserTiming',
          name: 'fractal:sidebar_interactive',
          startedAtMs: 1200,
          endedAtMs: 1500,
          durationMs: 300,
        },
      })
      f.host.advance(1000)
      f.deliver([
        { entryType: 'measure', name: 'other:thing', startTime: 1500, duration: 10 },
        { entryType: 'mark', name: 'fractal:switch_to_tail', startTime: 1600, duration: 0 },
        f.measure('fractal:switch_to_tail', 1700, 250),
      ])
      expect(view.latest).toEqual({
        _tag: 'Value',
        atMs: 3000,
        value: {
          _tag: 'UserTiming',
          name: 'fractal:switch_to_tail',
          startedAtMs: 2700,
          endedAtMs: 2950,
          durationMs: 250,
        },
      })
      expect(durations(view)).toEqual([300, 250])
      yield* Scope.close(scope, Exit.succeed(undefined))
      expect(f.state.disconnects).toBe(1)
    }),
  )

  it.effect('records one delivery in completion order with true overlapping times', () =>
    Effect.gen(function* () {
      const f = fixture({ filter: { _tag: 'Prefix', prefix: 'fractal:' } })
      f.host.advance(1000)
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* f.meters.start
          f.deliver([f.measure('fractal:a', 0, 200), f.measure('fractal:b', 100, 10)])
          const view = f.meters.store.read({ series: f.series })
          const values = Array.from({ length: view.length }, (_, index) => view.at(index))
          expect(values).toEqual([
            {
              _tag: 'Value',
              atMs: 1000,
              // performance.now() trails the session clock by 1000 ms.
              value: {
                _tag: 'UserTiming',
                name: 'fractal:b',
                startedAtMs: 1100,
                endedAtMs: 1110,
                durationMs: 10,
              },
            },
            {
              _tag: 'Value',
              atMs: 1000,
              value: {
                _tag: 'UserTiming',
                name: 'fractal:a',
                startedAtMs: 1000,
                endedAtMs: 1200,
                durationMs: 200,
              },
            },
          ])
        }),
      )
    }),
  )

  it.effect('filters exact names and records each entry once across leases', () =>
    Effect.gen(function* () {
      const f = fixture({ filter: { _tag: 'Names', names: ['fractal:open_transcript'] } })
      f.host.advance(3000)
      f.measure('fractal:open_transcript', 100, 40)
      f.measure('fractal:keystroke_paint', 150, 8)
      yield* Effect.scoped(f.meters.start)
      const view = f.meters.store.read({ series: f.series })
      expect(durations(view)).toEqual([40])
      // A second lease replays the whole buffer: only new entries are recorded, including a
      // distinct measure that ends exactly when an old one did.
      f.host.advance(500)
      f.measure('fractal:open_transcript', 120, 20)
      f.measure('fractal:open_transcript', 2400, 60)
      yield* Effect.scoped(f.meters.start)
      expect(durations(view)).toEqual([40, 20, 60])
    }),
  )

  it.effect('reports an invalid measure once as MeasurementFailed', () =>
    Effect.gen(function* () {
      const f = fixture({ filter: { _tag: 'Prefix', prefix: 'fractal:' } })
      f.host.advance(1000)
      f.measure('fractal:broken', Infinity, 5)
      f.measure('fractal:nan', 10, NaN)
      yield* Effect.scoped(f.meters.start)
      const view = f.meters.store.read({ series: f.series })
      const failures = () =>
        Array.from({ length: view.length }, (_, index) => view.at(index)).filter(
          (sample) => sample?._tag === 'Unavailable' && sample.reason === 'MeasurementFailed',
        ).length
      expect(failures()).toBe(2)
      // After a restart the replayed invalid entries are not reported again; a valid one is.
      f.measure('fractal:open_transcript', 500, 30)
      yield* Effect.scoped(f.meters.start)
      expect(failures()).toBe(2)
      expect(durations(view)).toEqual([30])
    }),
  )

  it.effect('reports Unsupported, never a zero, without measure support', () =>
    Effect.gen(function* () {
      const f = fixture({ filter: { _tag: 'Prefix', prefix: 'fractal:' }, supported: false })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* f.meters.start
          expect(f.meters.store.read({ series: f.series }).latest).toEqual({
            _tag: 'Unavailable',
            atMs: 0,
            reason: 'Unsupported',
          })
        }),
      )
      expect(f.state.constructions).toBe(0)
    }),
  )

  it('rejects an empty filter at construction', () => {
    const series = makeSeries<UserTimingValue>({ id: 't', label: 'T', unit: 'ms', capacity: 2 })
    expect(() =>
      userTimingSource({ id: 't', series, filter: { _tag: 'Prefix', prefix: '' } }),
    ).toThrow(TypeError)
    expect(() =>
      userTimingSource({ id: 't', series, filter: { _tag: 'Names', names: [] } }),
    ).toThrow(TypeError)
  })
})
