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
  it.effect('records matching measures as event samples dated at their end', () =>
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
        atMs: 1500,
        value: {
          _tag: 'UserTiming',
          name: 'fractal:sidebar_interactive',
          startedAtMs: 1200,
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
        atMs: 2950,
        value: {
          _tag: 'UserTiming',
          name: 'fractal:switch_to_tail',
          startedAtMs: 2700,
          durationMs: 250,
        },
      })
      expect(durations(view)).toEqual([300, 250])
      yield* Scope.close(scope, Exit.succeed(undefined))
      expect(f.state.disconnects).toBe(1)
    }),
  )

  it.effect('filters exact names and never records a replayed measure twice', () =>
    Effect.gen(function* () {
      const f = fixture({ filter: { _tag: 'Names', names: ['fractal:open_transcript'] } })
      f.host.advance(3000)
      f.measure('fractal:open_transcript', 100, 40)
      f.measure('fractal:keystroke_paint', 150, 8)
      yield* Effect.scoped(f.meters.start)
      const view = f.meters.store.read({ series: f.series })
      expect(durations(view)).toEqual([40])
      // A second lease replays the whole buffer; only the new measure is recorded.
      f.host.advance(500)
      f.measure('fractal:open_transcript', 2400, 60)
      yield* Effect.scoped(f.meters.start)
      expect(durations(view)).toEqual([40, 60])
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
