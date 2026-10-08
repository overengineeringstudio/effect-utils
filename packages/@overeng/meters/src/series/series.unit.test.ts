import { describe, expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import { makeSeries, makeSeriesStore, type NumberValue } from './index.ts'

describe('bounded shared histories', () => {
  it.effect.prop(
    'retains exactly the latest capacity without draining either reader',
    [
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
    ],
    ([capacity, count]) =>
      Effect.sync(() => {
        const series = makeSeries<NumberValue>({
          id: 'count',
          label: 'Count',
          unit: 'count',
          capacity,
        })
        const store = makeSeriesStore()
        const writer = store.register({ series })
        const first = store.read({ series })
        const second = store.read({ series })
        for (let index = 0; index < count; index++)
          writer.append({
            sample: { _tag: 'Value', atMs: index, value: { _tag: 'Number', value: index } },
          })
        expect(first.length).toBe(Math.min(capacity, count))
        expect(first.overflowCount).toBe(Math.max(0, count - capacity))
        expect(first.firstRetainedSequence).toBe(Math.max(0, count - capacity))
        expect(first.nextSequence).toBe(count)
        expect(first.oldestAtMs).toBe(Math.max(0, count - capacity))
        expect(first.newestAtMs).toBe(count - 1)
        expect(second.at(0)).toBe(first.at(0))
        const snapshot = store.snapshotSeries({ series })
        expect(store.snapshotSeries({ series })).toBe(snapshot)
        writer.append({ sample: { _tag: 'Unavailable', atMs: count, reason: 'Unsupported' } })
        expect(snapshot.samples).toHaveLength(Math.min(capacity, count))
        expect(store.snapshotSeries({ series })).not.toBe(snapshot)
      }),
  )

  it.effect('notifies independently and preserves unavailable, gap, and measured zero', () =>
    Effect.sync(() => {
      const series = makeSeries<NumberValue>({
        id: 'events',
        label: 'Events',
        unit: 'count',
        capacity: 3,
      })
      const store = makeSeriesStore()
      const writer = store.register({ series })
      let a = 0
      let b = 0
      const release = store.subscribe({
        notify: () => {
          a++
        },
      })
      store.subscribe({
        notify: () => {
          b++
        },
      })
      writer.append({ sample: { _tag: 'Value', atMs: 0, value: { _tag: 'Number', value: 0 } } })
      release()
      writer.append({ sample: { _tag: 'Gap', atMs: 1, durationMs: 1, reason: 'Hidden' } })
      writer.append({ sample: { _tag: 'Unavailable', atMs: 2, reason: 'MeasurementFailed' } })
      expect(a).toBe(1)
      expect(b).toBe(3)
      expect(store.snapshotSeries({ series }).samples.map((sample) => sample._tag)).toEqual([
        'Value',
        'Gap',
        'Unavailable',
      ])
      expect(() =>
        writer.append({ sample: { _tag: 'Value', atMs: 0, value: { _tag: 'Number', value: 1 } } }),
      ).toThrow()
    }),
  )

  it.effect('rejects invalid definitions and duplicate payload identities', () =>
    Effect.sync(() => {
      expect(() => makeSeries({ id: 'bad id', label: '', unit: 'count', capacity: 1 })).toThrow()
      expect(() => makeSeries({ id: 'ok', label: '', unit: 'count', capacity: 0 })).toThrow()
      const store = makeSeriesStore()
      store.register({
        series: makeSeries<number>({ id: 'same', label: '', unit: 'count', capacity: 1 }),
      })
      expect(() =>
        store.register({
          series: makeSeries<string>({ id: 'same', label: '', unit: 'status', capacity: 1 }),
        }),
      ).toThrow()
    }),
  )

  it.effect('delivers other notifications before reporting a subscriber defect', () =>
    Effect.sync(() => {
      const series = makeSeries<number>({ id: 'value', label: '', unit: 'count', capacity: 1 })
      const store = makeSeriesStore()
      const writer = store.register({ series })
      let delivered = false
      store.subscribe({
        notify: () => {
          throw new Error('subscriber failure')
        },
      })
      store.subscribe({
        notify: () => {
          delivered = true
        },
      })
      expect(() => writer.append({ sample: { _tag: 'Value', atMs: 0, value: 1 } })).toThrow(
        AggregateError,
      )
      expect(delivered).toBe(true)
      expect(store.read({ series }).length).toBe(1)
    }),
  )
})
