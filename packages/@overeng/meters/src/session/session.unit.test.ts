import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Exit, Fiber, Scope } from 'effect'
import { TestClock } from 'effect/testing'

import { makeSeries, type NumberValue, type SeriesWriter } from '../series/index.ts'
import { testPlatform } from './_test-platform.ts'
import { makeMeters, makeSource, runInterval, type SourceError } from './index.ts'

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
})
