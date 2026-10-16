import { describe, expect, it } from '@effect/vitest'
import { Cause, Deferred, Effect, ErrorReporter, Exit, Fiber, Scope } from 'effect'
import { TestClock } from 'effect/testing'

import {
  makeSeries,
  type NumberValue,
  type SeriesWriter,
  type StatusValue,
} from '../series/index.ts'
import { testPlatform } from './_test-platform.ts'
import { makeMeters, makeSource, runInterval, type SourceError } from './index.ts'

const windowFaultFixture = () => {
  const host = testPlatform()
  const series = makeSeries<number>({ id: 'fault-window', label: '', unit: 'count', capacity: 20 })
  const sinks: SeriesWriter<number>[] = []
  const meters = makeMeters({
    platform: { ...host.platform, supportsFrames: () => false },
    sources: [
      makeSource({
        id: 'fault-window',
        series,
        cadence: { _tag: 'Event' },
        freshness: { _tag: 'Window', ms: 100 },
        start: ({ sink }) =>
          Effect.sync(() => {
            sinks.push(sink)
          }),
      }),
    ],
  })
  return { host, series, sinks, meters }
}

describe('scoped meters sessions', () => {
  it.effect('constructs inertly and shares one collector and clock across readers', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      let acquired = 0
      let released = 0
      const series = makeSeries<NumberValue>({
        id: 'source',
        label: 'Source',
        unit: 'count',
        capacity: 10,
      })
      const order: string[] = []
      const source = makeSource({
        id: 'source',
        series,
        cadence: { _tag: 'PerFrame' },
        start: ({ sink, clock }) =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                acquired++
              }),
              () =>
                Effect.sync(() => {
                  released++
                }),
            )
            yield* clock.subscribe({
              phase: 'Source',
              listener: (tick) => {
                order.push('source')
                sink.append({
                  sample: {
                    _tag: 'Value',
                    atMs: tick.atMs,
                    value: { _tag: 'Number', value: tick.sequence },
                  },
                })
              },
            })
          }),
      })
      const meters = makeMeters({ sources: [source], platform: host.platform })
      expect(acquired).toBe(0)
      expect(host.requests).toBe(0)
      expect(host.observers).toBe(0)
      const first = yield* Scope.make()
      const second = yield* Scope.make()
      yield* Scope.provide(meters.start, first)
      yield* Scope.provide(meters.start, second)
      yield* Scope.provide(
        meters.clock.subscribe({
          phase: 'Draw',
          listener: () => {
            order.push('drawA')
          },
        }),
        first,
      )
      yield* Scope.provide(
        meters.clock.subscribe({
          phase: 'Draw',
          listener: () => {
            order.push('drawB')
          },
        }),
        second,
      )
      const readerA = meters.store.read({ series })
      const readerB = meters.store.read({ series })
      host.tick()
      expect(order).toEqual(['source', 'drawA', 'drawB'])
      expect(readerA.length).toBe(1)
      expect(readerB.length).toBe(1)
      expect(acquired).toBe(1)
      expect(host.peakPending).toBe(1)
      expect(host.observers).toBe(1)
      yield* Scope.close(first, Exit.succeed(undefined))
      expect(released).toBe(0)
      expect(host.pending).toBe(1)
      yield* Scope.close(second, Exit.succeed(undefined))
      expect(released).toBe(1)
      expect(host.pending).toBe(0)
      expect(host.observers).toBe(0)
    }),
  )

  it.effect('rolls back partial acquisition transactionally', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      let active = 0
      const first = makeSource({
        id: 'first',
        series: makeSeries<number>({ id: 'first', label: '', unit: 'count', capacity: 1 }),
        cadence: { _tag: 'Event' },
        start: () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              active++
            }),
            () =>
              Effect.sync(() => {
                active--
              }),
          ).pipe(Effect.asVoid),
      })
      const second = makeSource({
        id: 'second',
        series: makeSeries<number>({ id: 'second', label: '', unit: 'count', capacity: 1 }),
        cadence: { _tag: 'Event' },
        start: () =>
          Effect.fail<SourceError>({
            _tag: 'SourceError',
            sourceId: 'second',
            reason: 'AcquisitionFailed',
            cause: new Error('installation failed'),
          }),
      })
      const meters = makeMeters({ sources: [first, second], platform: host.platform })
      const failed = yield* Effect.flip(meters.start)
      expect(failed.reason).toBe('AcquisitionFailed')
      expect(active).toBe(0)
      expect(host.observers).toBe(0)
    }),
  )

  it.effect('serializes reacquisition behind asynchronous cleanup and rejects old sinks', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const cleanup = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const series = makeSeries<number>({ id: 'events', label: '', unit: 'count', capacity: 10 })
      const sinks: SeriesWriter<number>[] = []
      let acquired = 0
      const source = makeSource({
        id: 'events',
        series,
        cadence: { _tag: 'Event' },
        start: ({ sink }) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              acquired++
              sinks.push(sink)
            }),
            () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(cleaning, undefined)
                yield* Deferred.await(cleanup)
              }),
          ).pipe(Effect.asVoid),
      })
      const meters = makeMeters({ sources: [source], platform: host.platform })
      const first = yield* Scope.make()
      yield* Scope.provide(meters.start, first)
      const closing = yield* Effect.forkChild(Scope.close(first, Exit.succeed(undefined)))
      yield* Deferred.await(cleaning)
      expect(host.observers).toBe(0)
      const second = yield* Scope.make()
      const opening = yield* Effect.forkChild(Scope.provide(meters.start, second))
      yield* Effect.yieldNow
      expect(acquired).toBe(1)
      sinks[0]?.append({ sample: { _tag: 'Value', atMs: 0, value: 1 } })
      expect(meters.store.read({ series }).length).toBe(0)
      yield* Deferred.succeed(cleanup, undefined)
      yield* Fiber.join(closing)
      yield* Fiber.join(opening)
      expect(acquired).toBe(2)
      sinks[0]?.append({ sample: { _tag: 'Value', atMs: 0, value: 2 } })
      sinks[1]?.append({ sample: { _tag: 'Value', atMs: 0, value: 3 } })
      expect(meters.store.read({ series }).length).toBe(1)
      yield* Scope.close(second, Exit.succeed(undefined))
    }),
  )

  it.effect('pauses single-flight interval sampling while hidden', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      let observations = 0
      const series = makeSeries<number>({ id: 'interval', label: '', unit: 'count', capacity: 10 })
      const source = makeSource({
        id: 'interval',
        series,
        cadence: { _tag: 'Interval', everyMs: 100 },
        start: ({ clock, sink }) =>
          runInterval({
            clock,
            everyMs: 100,
            observe: Effect.sync(() => {
              observations++
              sink.append({ sample: { _tag: 'Value', atMs: clock.now(), value: observations } })
            }),
          }),
      })
      const meters = makeMeters({ sources: [source], platform: host.platform })
      yield* meters.start
      yield* Effect.yieldNow
      expect(observations).toBe(1)
      expect(host.pending).toBe(0)
      host.setVisible(false)
      host.advance(1000)
      yield* TestClock.adjust(1000)
      expect(observations).toBe(1)
      host.setVisible(true)
      yield* Effect.yieldNow
      expect(observations).toBe(2)
      expect(
        meters.store.snapshotSeries({ series }).samples.some((sample) => sample._tag === 'Gap'),
      ).toBe(true)
    }),
  )

  it.effect(
    'expires one shared window without readers or frame support and renews measured failures',
    () =>
      Effect.gen(function* () {
        const host = testPlatform()
        const series = makeSeries<number>({ id: 'window', label: '', unit: 'ms', capacity: 20 })
        const sinks: SeriesWriter<number>[] = []
        const source = makeSource({
          id: 'window',
          series,
          cadence: { _tag: 'Event' },
          freshness: { _tag: 'Window', ms: 100 },
          start: ({ sink }) =>
            Effect.sync(() => {
              sinks.push(sink)
            }),
        })
        const meters = makeMeters({
          sources: [source],
          platform: { ...host.platform, supportsFrames: () => false },
        })
        const scope = yield* Scope.make()
        yield* Scope.provide(meters.start, scope)
        sinks[0]?.append({ sample: { _tag: 'Value', atMs: 0, value: 42 } })
        yield* Effect.yieldNow
        host.advance(60)
        yield* TestClock.adjust(60)
        sinks[0]?.append({ sample: { _tag: 'Unavailable', atMs: 60, reason: 'MeasurementFailed' } })
        const failed = meters.store.read({ series }).latest
        expect(failed).toEqual({
          _tag: 'Unavailable',
          atMs: 60,
          reason: 'MeasurementFailed',
          lastKnown: { atMs: 0, value: 42 },
        })
        host.advance(40)
        yield* TestClock.adjust(40)
        expect(meters.store.read({ series }).latest).toBe(failed)
        host.advance(60)
        yield* TestClock.adjust(60)
        const stale = meters.store.read({ series }).latest
        expect(stale).toEqual({
          _tag: 'Unavailable',
          atMs: 160,
          reason: 'Stale',
          lastKnown: { atMs: 0, value: 42 },
        })
        expect(meters.store.snapshotSeries({ series }).samples.at(-1)).toBe(stale)
        expect(host.requests).toBe(0)
        // A delayed result cannot move materialized history backward or resurrect a value.
        sinks[0]?.append({ sample: { _tag: 'Value', atMs: 100, value: 99 } })
        expect(meters.store.read({ series }).latest).toBe(stale)
        yield* Scope.close(scope, Exit.succeed(undefined))
        const stopped = meters.store.read({ series }).latest
        expect(stopped?._tag === 'Unavailable' && stopped.reason).toBe('Stopped')
        sinks[0]?.append({ sample: { _tag: 'Value', atMs: 160, value: 99 } })
        host.advance(1000)
        yield* TestClock.adjust(1000)
        expect(meters.store.read({ series }).latest).toBe(stopped)
      }),
  )

  it.effect(
    'uses observation age, never renews gaps, and preserves explicit capability failures',
    () =>
      Effect.gen(function* () {
        const host = testPlatform()
        host.advance(80)
        const series = makeSeries<number>({ id: 'age', label: '', unit: 'count', capacity: 20 })
        const sinks: SeriesWriter<number>[] = []
        const meters = makeMeters({
          platform: host.platform,
          sources: [
            makeSource({
              id: 'age',
              series,
              cadence: { _tag: 'Event' },
              freshness: { _tag: 'Window', ms: 100 },
              start: ({ sink }) =>
                Effect.sync(() => {
                  sinks.push(sink)
                }),
            }),
          ],
        })
        yield* meters.start
        sinks[0]?.append({ sample: { _tag: 'Value', atMs: 0, value: 1 } })
        yield* Effect.yieldNow
        host.advance(10)
        yield* TestClock.adjust(10)
        sinks[0]?.append({ sample: { _tag: 'Gap', atMs: 90, durationMs: 10, reason: 'Overflow' } })
        host.advance(10)
        yield* TestClock.adjust(10)
        expect(meters.store.read({ series }).latest).toEqual({
          _tag: 'Unavailable',
          atMs: 100,
          reason: 'Stale',
          lastKnown: { atMs: 0, value: 1 },
        })
        sinks[0]?.append({ sample: { _tag: 'Value', atMs: 100, value: 2 } })
        yield* Effect.yieldNow
        host.advance(10)
        sinks[0]?.append({ sample: { _tag: 'Unavailable', atMs: 110, reason: 'Unsupported' } })
        const unsupported = meters.store.read({ series }).latest
        host.advance(1000)
        yield* TestClock.adjust(1010)
        expect(meters.store.read({ series }).latest).toBe(unsupported)
      }),
  )

  it.effect(
    'resolves selected status before synchronous source acquisition without gating independent windows',
    () =>
      Effect.gen(function* () {
        const host = testPlatform()
        const status = makeSeries<StatusValue>({
          id: 'status',
          label: '',
          unit: 'status',
          capacity: 20,
        })
        const dependent = makeSeries<number>({
          id: 'dependent',
          label: '',
          unit: 'count',
          capacity: 20,
        })
        const independent = makeSeries<number>({
          id: 'independent',
          label: '',
          unit: 'ms',
          capacity: 20,
        })
        const statusSinks: SeriesWriter<StatusValue>[] = []
        const sinks: SeriesWriter<number>[] = []
        let acquired = 0
        const statusSource = makeSource({
          id: 'status',
          series: status,
          cadence: { _tag: 'Event' },
          start: ({ sink }) =>
            Effect.sync(() => {
              acquired++
              statusSinks.push(sink)
              sink.append({
                sample: {
                  _tag: 'Value',
                  atMs: host.platform.now(),
                  value: { _tag: 'Status', state: 'Connected', label: 'Connected' },
                },
              })
            }),
        })
        const source = makeSource({
          id: 'dependent',
          series: dependent,
          cadence: { _tag: 'Event' },
          freshness: { _tag: 'While', status, state: 'Connected' },
          start: ({ sink }) =>
            Effect.sync(() => {
              sinks.push(sink)
              sink.append({ sample: { _tag: 'Value', atMs: host.platform.now(), value: 4 } })
            }),
        })
        const window = makeSource({
          id: 'independent',
          series: independent,
          cadence: { _tag: 'Event' },
          freshness: { _tag: 'Window', ms: 60000 },
          start: ({ sink }) =>
            Effect.sync(() => {
              sink.append({ sample: { _tag: 'Unavailable', atMs: 0, reason: 'MeasurementFailed' } })
            }),
        })
        const meters = makeMeters({
          platform: host.platform,
          sources: [source, window, statusSource],
        })
        const first = yield* Scope.make()
        const second = yield* Scope.make()
        yield* Scope.provide(meters.start, first)
        yield* Scope.provide(meters.start, second)
        expect(acquired).toBe(1)
        expect(meters.store.read({ series: dependent }).latest).toEqual({
          _tag: 'Value',
          atMs: 0,
          value: 4,
        })
        const httpFailure = meters.store.read({ series: independent }).latest
        host.advance(10)
        statusSinks[0]?.append({
          sample: {
            _tag: 'Value',
            atMs: 10,
            value: { _tag: 'Status', state: 'Disconnected', label: 'Offline' },
          },
        })
        expect(meters.store.read({ series: dependent }).latest).toEqual({
          _tag: 'Unavailable',
          atMs: 10,
          reason: 'Disconnected',
          lastKnown: { atMs: 0, value: 4 },
        })
        expect(meters.store.read({ series: independent }).latest).toBe(httpFailure)
        host.advance(10)
        statusSinks[0]?.append({
          sample: {
            _tag: 'Value',
            atMs: 20,
            value: { _tag: 'Status', state: 'Connected', label: 'Connected' },
          },
        })
        expect(meters.store.read({ series: dependent }).latest).toEqual({
          _tag: 'Unavailable',
          atMs: 20,
          reason: 'Stale',
          lastKnown: { atMs: 0, value: 4 },
        })
        sinks[0]?.append({ sample: { _tag: 'Unavailable', atMs: 20, reason: 'MeasurementFailed' } })
        statusSinks[0]?.append({
          sample: {
            _tag: 'Value',
            atMs: 20,
            value: { _tag: 'Status', state: 'Disconnected', label: 'Offline' },
          },
        })
        statusSinks[0]?.append({
          sample: {
            _tag: 'Value',
            atMs: 20,
            value: { _tag: 'Status', state: 'Connected', label: 'Connected' },
          },
        })
        expect(meters.store.read({ series: dependent }).latest).toEqual({
          _tag: 'Unavailable',
          atMs: 20,
          reason: 'MeasurementFailed',
          lastKnown: { atMs: 0, value: 4 },
        })
        sinks[0]?.append({ sample: { _tag: 'Value', atMs: 20, value: 5 } })
        yield* Scope.close(first, Exit.succeed(undefined))
        expect(meters.store.read({ series: dependent }).latest?._tag).toBe('Value')
        yield* Scope.close(second, Exit.succeed(undefined))
        const stopped = meters.store.read({ series: dependent }).latest
        statusSinks[0]?.append({
          sample: {
            _tag: 'Value',
            atMs: 20,
            value: { _tag: 'Status', state: 'Disconnected', label: 'Offline' },
          },
        })
        expect(meters.store.read({ series: dependent }).latest).toBe(stopped)
        expect(stopped?._tag === 'Unavailable' && stopped.reason).toBe('Stopped')
      }),
  )

  it.effect('keeps hidden periodic evidence and resume gaps ahead of expiry', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const series = makeSeries<number>({ id: 'hidden', label: '', unit: 'count', capacity: 20 })
      const sinks: SeriesWriter<number>[] = []
      const meters = makeMeters({
        platform: host.platform,
        sources: [
          makeSource({
            id: 'hidden',
            series,
            cadence: { _tag: 'Interval', everyMs: 100 },
            freshness: { _tag: 'Window', ms: 100 },
            start: ({ sink }) =>
              Effect.sync(() => {
                sinks.push(sink)
                sink.append({ sample: { _tag: 'Value', atMs: 0, value: 7 } })
              }),
          }),
        ],
      })
      yield* meters.start
      yield* Effect.yieldNow
      host.advance(10)
      host.setVisible(false)
      const hidden = meters.store.read({ series }).latest
      expect(hidden?._tag === 'Unavailable' && hidden.reason).toBe('Hidden')
      host.advance(100)
      yield* TestClock.adjust(110)
      expect(meters.store.read({ series }).latest).toBe(hidden)
      host.setVisible(true)
      expect(meters.store.snapshotSeries({ series }).samples.slice(-2)).toEqual([
        { _tag: 'Gap', atMs: 110, durationMs: 100, reason: 'Hidden' },
        { _tag: 'Unavailable', atMs: 110, reason: 'Stale', lastKnown: { atMs: 0, value: 7 } },
      ])
      sinks[0]?.append({ sample: { _tag: 'Value', atMs: 110, value: 8 } })
      expect(meters.store.read({ series }).latest?._tag).toBe('Value')
    }),
  )

  it('rejects missing, same-id impostor, cyclic and invalid freshness configuration inertly', () => {
    const host = testPlatform()
    const status = makeSeries<StatusValue>({ id: 'status', label: '', unit: 'status', capacity: 2 })
    const impostor = makeSeries<StatusValue>({
      id: 'status',
      label: '',
      unit: 'status',
      capacity: 2,
    })
    const source = makeSource({
      id: 'dependent',
      series: makeSeries<number>({ id: 'dependent', label: '', unit: 'count', capacity: 2 }),
      cadence: { _tag: 'Event' },
      freshness: { _tag: 'While', status, state: 'Connected' },
      start: () => Effect.void,
    })
    expect(() => makeMeters({ sources: [source], platform: host.platform })).toThrow(
      'explicitly selected',
    )
    expect(() =>
      makeMeters({
        sources: [
          source,
          makeSource({
            id: 'status',
            series: impostor,
            cadence: { _tag: 'Event' },
            start: () => Effect.void,
          }),
        ],
        platform: host.platform,
      }),
    ).toThrow('explicitly selected')
    const cyclic = makeSource({
      id: 'status',
      series: status,
      cadence: { _tag: 'Event' },
      freshness: { _tag: 'While', status, state: 'Connected' },
      start: () => Effect.void,
    })
    expect(() => makeMeters({ sources: [cyclic], platform: host.platform })).toThrow('Cyclic')
    expect(() =>
      makeSource({
        id: 'invalid',
        series: source.series,
        cadence: { _tag: 'Event' },
        freshness: { _tag: 'Window', ms: Number.NaN },
        start: () => Effect.void,
      }),
    ).toThrow('finite and positive')
    expect(host.observers).toBe(0)
    expect(host.requests).toBe(0)
  })
  it.effect(
    'does not reuse a previous generation connection and disposes policy work on rollback',
    () =>
      Effect.gen(function* () {
        const host = testPlatform()
        const status = makeSeries<StatusValue>({
          id: 'restart-status',
          label: '',
          unit: 'status',
          capacity: 10,
        })
        const series = makeSeries<number>({ id: 'restart', label: '', unit: 'count', capacity: 20 })
        const sinks: SeriesWriter<number>[] = []
        let generation = 0
        const statusSource = makeSource({
          id: 'restart-status',
          series: status,
          cadence: { _tag: 'Event' },
          start: ({ sink }) =>
            Effect.sync(() => {
              generation++
              if (generation === 1)
                sink.append({
                  sample: {
                    _tag: 'Value',
                    atMs: 0,
                    value: { _tag: 'Status', state: 'Connected', label: 'Connected' },
                  },
                })
            }),
        })
        const dependent = makeSource({
          id: 'restart',
          series,
          cadence: { _tag: 'Event' },
          freshness: { _tag: 'While', status, state: 'Connected' },
          start: ({ sink }) =>
            Effect.sync(() => {
              sinks.push(sink)
              sink.append({
                sample: { _tag: 'Value', atMs: host.platform.now(), value: generation },
              })
            }),
        })
        const meters = makeMeters({ platform: host.platform, sources: [dependent, statusSource] })
        const first = yield* Scope.make()
        yield* Scope.provide(meters.start, first)
        yield* Scope.close(first, Exit.succeed(undefined))
        host.advance(10)
        const second = yield* Scope.make()
        yield* Scope.provide(meters.start, second)
        expect(meters.store.read({ series }).latest).toEqual({
          _tag: 'Unavailable',
          atMs: 10,
          reason: 'Disconnected',
          lastKnown: { atMs: 0, value: 1 },
        })
        sinks[0]?.append({ sample: { _tag: 'Value', atMs: 10, value: 99 } })
        expect(meters.store.read({ series }).latest?._tag).toBe('Unavailable')
        yield* Scope.close(second, Exit.succeed(undefined))

        const windowSeries = makeSeries<number>({
          id: 'rollback-window',
          label: '',
          unit: 'count',
          capacity: 10,
        })
        const failed = makeMeters({
          platform: host.platform,
          sources: [
            makeSource({
              id: 'rollback-window',
              series: windowSeries,
              cadence: { _tag: 'Event' },
              freshness: { _tag: 'Window', ms: 100 },
              start: ({ sink }) =>
                Effect.sync(() => {
                  sinks.push(sink)
                  sink.append({ sample: { _tag: 'Value', atMs: 10, value: 3 } })
                }),
            }),
            makeSource({
              id: 'fails',
              series: makeSeries<number>({ id: 'fails', label: '', unit: 'count', capacity: 1 }),
              cadence: { _tag: 'Event' },
              start: () =>
                Effect.fail<SourceError>({
                  _tag: 'SourceError',
                  sourceId: 'fails',
                  reason: 'AcquisitionFailed',
                  cause: new Error('failed'),
                }),
            }),
          ],
        })
        yield* Effect.flip(failed.start)
        const stopped = failed.store.read({ series: windowSeries }).latest
        expect(stopped?._tag === 'Unavailable' && stopped.reason).toBe('Stopped')
        host.advance(1000)
        yield* TestClock.adjust(1000)
        sinks.at(-1)?.append({ sample: { _tag: 'Value', atMs: 1010, value: 99 } })
        expect(failed.store.read({ series: windowSeries }).latest).toBe(stopped)
        expect(host.observers).toBe(0)
      }),
  )

  it.effect(
    'delivers every While dependency and originating publication despite observer faults',
    () =>
      Effect.gen(function* () {
        const host = testPlatform()
        const status = makeSeries<StatusValue>({
          id: 'fanout-status',
          label: '',
          unit: 'status',
          capacity: 10,
        })
        const statusSinks: SeriesWriter<StatusValue>[] = []
        const series = ['a', 'b'].map((id) =>
          makeSeries<number>({ id, label: id, unit: 'count', capacity: 10 }),
        )
        const dependents = series.map((dependent) =>
          makeSource({
            id: dependent.id,
            series: dependent,
            cadence: { _tag: 'Event' },
            freshness: { _tag: 'While', status, state: 'Connected' },
            start: ({ sink }) =>
              Effect.sync(() => {
                sink.append({ sample: { _tag: 'Value', atMs: 0, value: 1 } })
              }),
          }),
        )
        const connection = makeSource({
          id: 'fanout-status',
          series: status,
          cadence: { _tag: 'Event' },
          start: ({ sink }) =>
            Effect.sync(() => {
              statusSinks.push(sink)
              sink.append({
                sample: {
                  _tag: 'Value',
                  atMs: 0,
                  value: { _tag: 'Status', state: 'Connected', label: 'Connected' },
                },
              })
            }),
        })
        const meters = makeMeters({ platform: host.platform, sources: [...dependents, connection] })
        yield* meters.start
        let throwOnce = true
        const releaseFault = meters.store.subscribe({
          notify: () => {
            if (throwOnce === true) {
              throwOnce = false
              throw new Error('observer fault')
            }
          },
        })
        let delivered = 0
        const releaseReader = meters.store.subscribe({
          notify: () => {
            delivered++
          },
        })
        const revision = meters.store.getRevision()
        host.advance(1)
        expect(() =>
          statusSinks[0]?.append({
            sample: {
              _tag: 'Value',
              atMs: 1,
              value: { _tag: 'Status', state: 'Disconnected', label: 'Offline' },
            },
          }),
        ).toThrow(AggregateError)
        for (const dependent of series) {
          expect(meters.store.read({ series: dependent }).latest).toEqual({
            _tag: 'Unavailable',
            atMs: 1,
            reason: 'Disconnected',
            lastKnown: { atMs: 0, value: 1 },
          })
        }
        expect(delivered).toBe(3)
        expect(meters.store.getRevision()).toBe(revision + 3)
        releaseFault()
        releaseReader()
      }),
  )

  it.effect('arms a committed Window observation even when its initial publication throws', () =>
    Effect.gen(function* () {
      const { host, series, sinks, meters } = windowFaultFixture()
      yield* meters.start
      const releaseFault = meters.store.subscribe({
        notify: () => {
          throw new Error('initial observer fault')
        },
      })
      expect(() => sinks[0]?.append({ sample: { _tag: 'Value', atMs: 0, value: 1 } })).toThrow(
        AggregateError,
      )
      releaseFault()
      yield* Effect.yieldNow
      host.advance(100)
      yield* TestClock.adjust(100)
      expect(meters.store.read({ series }).latest).toEqual({
        _tag: 'Unavailable',
        atMs: 100,
        reason: 'Stale',
        lastKnown: { atMs: 0, value: 1 },
      })
    }),
  )

  it.effect('rearms Window ownership after an expiry publication defect', () => {
    const reported: unknown[] = []
    const expiryFault = new Error('expiry observer fault')
    const reporter = ErrorReporter.make(({ cause }) => reported.push(Cause.squash(cause)))
    return Effect.gen(function* () {
      const { host, series, sinks, meters } = windowFaultFixture()
      yield* meters.start
      sinks[0]?.append({ sample: { _tag: 'Value', atMs: 0, value: 1 } })
      yield* Effect.yieldNow
      let faulted = false
      const releaseFault = meters.store.subscribe({
        notify: () => {
          if (faulted === false && meters.store.read({ series }).latest?._tag === 'Unavailable') {
            faulted = true
            throw expiryFault
          }
        },
      })
      host.advance(100)
      yield* TestClock.adjust(100)
      expect(faulted).toBe(true)
      expect(meters.store.read({ series }).latest?._tag).toBe('Unavailable')
      expect(reported).toMatchObject([{ errors: [{ errors: [expiryFault] }] }])
      releaseFault()
      sinks[0]?.append({ sample: { _tag: 'Value', atMs: 100, value: 2 } })
      yield* Effect.yieldNow
      host.advance(100)
      yield* TestClock.adjust(100)
      expect(meters.store.read({ series }).latest).toEqual({
        _tag: 'Unavailable',
        atMs: 200,
        reason: 'Stale',
        lastKnown: { atMs: 100, value: 2 },
      })
    }).pipe(Effect.provide(ErrorReporter.layer([reporter], { mergeWithExisting: false })))
  })

  it.effect(
    'expires a reentrant Window renewal after its retiring worker publication throws',
    () => {
      const reported: unknown[] = []
      const reentrantFault = new Error('reentrant observer fault')
      const reporter = ErrorReporter.make(({ cause }) => reported.push(Cause.squash(cause)))
      return Effect.gen(function* () {
        const { host, series, sinks, meters } = windowFaultFixture()
        yield* meters.start
        sinks[0]?.append({ sample: { _tag: 'Value', atMs: 0, value: 1 } })
        yield* Effect.yieldNow
        let renewed = false
        const releaseFault = meters.store.subscribe({
          notify: () => {
            if (renewed === false && meters.store.read({ series }).latest?._tag === 'Unavailable') {
              renewed = true
              sinks[0]?.append({ sample: { _tag: 'Value', atMs: host.platform.now(), value: 2 } })
              throw reentrantFault
            }
          },
        })
        host.advance(100)
        yield* TestClock.adjust(100)
        expect(renewed).toBe(true)
        expect(meters.store.read({ series }).latest).toEqual({ _tag: 'Value', atMs: 100, value: 2 })
        expect(reported).toMatchObject([{ errors: [{ errors: [reentrantFault] }] }])
        releaseFault()
        host.advance(100)
        yield* TestClock.adjust(100)
        expect(meters.store.read({ series }).latest).toEqual({
          _tag: 'Unavailable',
          atMs: 200,
          reason: 'Stale',
          lastKnown: { atMs: 100, value: 2 },
        })
      }).pipe(Effect.provide(ErrorReporter.layer([reporter], { mergeWithExisting: false })))
    },
  )

  it.effect(
    'materializes resumed disconnection after a gap observer defect and preserves later evidence',
    () => {
      const reported: unknown[] = []
      const reporter = ErrorReporter.make(({ cause }) => {
        reported.push(Cause.squash(cause))
      })
      return Effect.gen(function* () {
        const host = testPlatform()
        const status = makeSeries<StatusValue>({
          id: 'resume-status',
          label: '',
          unit: 'status',
          capacity: 10,
        })
        const series = makeSeries<number>({
          id: 'resume-dependent',
          label: '',
          unit: 'count',
          capacity: 20,
        })
        const statusSinks: SeriesWriter<StatusValue>[] = []
        const sinks: SeriesWriter<number>[] = []
        const meters = makeMeters({
          platform: host.platform,
          sources: [
            makeSource({
              id: 'resume-status',
              series: status,
              cadence: { _tag: 'Event' },
              start: ({ sink }) =>
                Effect.sync(() => {
                  statusSinks.push(sink)
                  sink.append({
                    sample: {
                      _tag: 'Value',
                      atMs: 0,
                      value: { _tag: 'Status', state: 'Connected', label: 'Connected' },
                    },
                  })
                }),
            }),
            makeSource({
              id: 'resume-dependent',
              series,
              cadence: { _tag: 'Interval', everyMs: 100 },
              freshness: { _tag: 'While', status, state: 'Connected' },
              start: ({ sink }) =>
                Effect.sync(() => {
                  sinks.push(sink)
                  sink.append({ sample: { _tag: 'Value', atMs: 0, value: 4 } })
                }),
            }),
          ],
        })
        const scope = yield* Scope.make()
        yield* Scope.provide(meters.start, scope)
        host.advance(10)
        host.setVisible(false)
        host.advance(10)
        statusSinks[0]?.append({
          sample: {
            _tag: 'Value',
            atMs: 20,
            value: { _tag: 'Status', state: 'Disconnected', label: 'Offline' },
          },
        })
        const gapFault = new Error('resume gap observer fault')
        let faulted = false
        const unsubscribe = meters.store.subscribe({
          notify: () => {
            if (faulted === false && meters.store.read({ series }).latest?._tag === 'Gap') {
              faulted = true
              throw gapFault
            }
          },
        })
        host.advance(10)
        host.setVisible(true)
        unsubscribe()
        yield* Effect.yieldNow
        expect(faulted).toBe(true)
        expect(meters.store.snapshotSeries({ series }).samples.slice(-2)).toEqual([
          { _tag: 'Gap', atMs: 30, durationMs: 20, reason: 'Hidden' },
          {
            _tag: 'Unavailable',
            atMs: 30,
            reason: 'Disconnected',
            lastKnown: { atMs: 0, value: 4 },
          },
        ])
        expect(reported).toMatchObject([{ errors: [{ errors: [{ errors: [gapFault] }] }] }])
        host.advance(10)
        statusSinks[0]?.append({
          sample: {
            _tag: 'Value',
            atMs: 40,
            value: { _tag: 'Status', state: 'Connected', label: 'Connected' },
          },
        })
        sinks[0]?.append({ sample: { _tag: 'Value', atMs: 40, value: 5 } })
        expect(meters.store.read({ series }).latest).toEqual({ _tag: 'Value', atMs: 40, value: 5 })
        yield* Scope.close(scope, Exit.succeed(undefined))
        const stopped = meters.store.read({ series }).latest
        expect(stopped).toEqual({
          _tag: 'Unavailable',
          atMs: 40,
          reason: 'Stopped',
          lastKnown: { atMs: 40, value: 5 },
        })
        sinks[0]?.append({ sample: { _tag: 'Value', atMs: 40, value: 99 } })
        expect(meters.store.read({ series }).latest).toBe(stopped)
      }).pipe(Effect.provide(ErrorReporter.layer([reporter], { mergeWithExisting: false })))
    },
  )

  it.effect(
    'preserves fresh Window observations committed reentrantly by a failing resume gap observer',
    () => {
      const reported: unknown[] = []
      const reporter = ErrorReporter.make(({ cause }) => {
        reported.push(Cause.squash(cause))
      })
      return Effect.gen(function* () {
        for (const observation of ['Value', 'MeasurementFailed'] as const) {
          const host = testPlatform()
          const series = makeSeries<number>({
            id: observation,
            label: '',
            unit: 'count',
            capacity: 20,
          })
          const sinks: SeriesWriter<number>[] = []
          const meters = makeMeters({
            platform: { ...host.platform, supportsFrames: () => false },
            sources: [
              makeSource({
                id: observation,
                series,
                cadence: { _tag: 'Interval', everyMs: 100 },
                freshness: { _tag: 'Window', ms: 100 },
                start: ({ sink }) =>
                  Effect.sync(() => {
                    sinks.push(sink)
                    sink.append({ sample: { _tag: 'Value', atMs: 0, value: 1 } })
                  }),
              }),
            ],
          })
          const scope = yield* Scope.make()
          yield* Scope.provide(meters.start, scope)
          yield* Effect.yieldNow
          host.advance(10)
          host.setVisible(false)
          host.advance(10)
          let renewed = false
          const gapFault = new Error(`reentrant resume ${observation} observer fault`)
          const unsubscribe = meters.store.subscribe({
            notify: () => {
              if (renewed === false && meters.store.read({ series }).latest?._tag === 'Gap') {
                renewed = true
                sinks[0]?.append({
                  sample:
                    observation === 'Value'
                      ? { _tag: 'Value', atMs: host.platform.now(), value: 2 }
                      : {
                          _tag: 'Unavailable',
                          atMs: host.platform.now(),
                          reason: 'MeasurementFailed',
                        },
                })
                throw gapFault
              }
            },
          })
          host.setVisible(true)
          unsubscribe()
          yield* Effect.yieldNow
          expect(renewed).toBe(true)
          expect(meters.store.snapshotSeries({ series }).samples.slice(-2)[0]).toEqual({
            _tag: 'Gap',
            atMs: 20,
            durationMs: 10,
            reason: 'Hidden',
          })
          expect(meters.store.read({ series }).latest).toEqual(
            observation === 'Value'
              ? { _tag: 'Value', atMs: 20, value: 2 }
              : {
                  _tag: 'Unavailable',
                  atMs: 20,
                  reason: 'MeasurementFailed',
                  lastKnown: { atMs: 0, value: 1 },
                },
          )
          expect(reported.at(-1)).toMatchObject({ errors: [{ errors: [{ errors: [gapFault] }] }] })
          host.advance(100)
          yield* TestClock.adjust(100)
          expect(meters.store.read({ series }).latest).toEqual({
            _tag: 'Unavailable',
            atMs: 120,
            reason: 'Stale',
            lastKnown: observation === 'Value' ? { atMs: 20, value: 2 } : { atMs: 0, value: 1 },
          })
          yield* Scope.close(scope, Exit.succeed(undefined))
          expect(
            meters.store.read({ series }).latest?._tag === 'Unavailable' &&
              meters.store.read({ series }).latest,
          ).toMatchObject({ reason: 'Stopped' })
        }
        expect(reported).toHaveLength(2)
      }).pipe(Effect.provide(ErrorReporter.layer([reporter], { mergeWithExisting: false })))
    },
  )
})
