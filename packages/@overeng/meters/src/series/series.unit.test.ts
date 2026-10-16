import { describe, expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import {
  bucketSeries,
  makeSeries,
  makeSeriesStore,
  type NumberValue,
  type Sample,
} from './index.ts'

describe('bounded shared histories', () => {
  it('publishes a committed append after its source hook fails and preserves all notification defects', () => {
    const series = makeSeries<number>({ id: 'faults', label: '', unit: 'count', capacity: 1 })
    const store = makeSeriesStore()
    const sourceFault = new Error('source hook fault')
    const readerFault = new Error('reader fault')
    const writer = store.register({
      series,
      onAppend: () => {
        throw sourceFault
      },
    })
    store.subscribe({
      notify: () => {
        throw readerFault
      },
    })
    let delivered = false
    store.subscribe({
      notify: () => {
        delivered = true
      },
    })
    let reported: unknown
    try {
      writer.append({ sample: { _tag: 'Value', atMs: 0, value: 1 } })
    } catch (cause) {
      reported = cause
    }
    expect(reported).toBeInstanceOf(AggregateError)
    if (reported instanceof AggregateError) {
      expect(reported.errors[0]).toBe(sourceFault)
      expect(reported.errors[1]).toBeInstanceOf(AggregateError)
      expect(reported.errors[1].errors).toEqual([readerFault])
    }
    expect(delivered).toBe(true)
    expect(store.getRevision()).toBe(1)
    expect(store.read({ series }).latest).toEqual({ _tag: 'Value', atMs: 0, value: 1 })
  })

  it('commits typed last-known evidence immutably before notifying readers', () => {
    const series = makeSeries<NumberValue>({
      id: 'last-known',
      label: '',
      unit: 'count',
      capacity: 1,
    })
    const store = makeSeriesStore()
    const order: string[] = []
    const writer = store.register({
      series,
      onAppend: () => {
        expect(store.read({ series }).latest?._tag).toBe('Unavailable')
        order.push('source')
      },
    })
    store.subscribe({
      notify: () => {
        order.push('reader')
      },
    })
    const lastKnown: { readonly atMs: number; readonly value: NumberValue } = {
      atMs: 1,
      value: { _tag: 'Number', value: 0 },
    }
    writer.append({ sample: { _tag: 'Unavailable', atMs: 2, reason: 'Stale', lastKnown } })
    expect(order).toEqual(['source', 'reader'])
    expect(Object.isFrozen(lastKnown)).toBe(true)
    expect(Object.isFrozen(lastKnown.value)).toBe(true)
    expect(store.snapshotSeries({ series }).samples[0]).toEqual({
      _tag: 'Unavailable',
      atMs: 2,
      reason: 'Stale',
      lastKnown,
    })
    expect(() =>
      writer.append({
        sample: {
          _tag: 'Unavailable',
          atMs: 3,
          reason: 'Disconnected',
          lastKnown: { atMs: 4, value: { _tag: 'Number', value: 1 } },
        },
      }),
    ).toThrow('Last-known timestamp')
    expect(() =>
      writer.append({
        sample: {
          _tag: 'Unavailable',
          atMs: 3,
          reason: 'Stale',
          lastKnown: { atMs: 1, value: { _tag: 'Number', value: Number.NaN } },
        },
      }),
    ).toThrow('finite')
  })

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

describe('bucketSeries', () => {
  it('keeps endpoint, partial observation, non-value, reset and retained-history semantics', () => {
    const series = makeSeries<number>({ id: 'bins', label: 'Bins', unit: 'count', capacity: 8 })
    const store = makeSeriesStore()
    const writer = store.register({ series })
    const history = store.read({ series })
    const read = (mode: 'Gauge' | 'Event' | 'Counter') =>
      bucketSeries({ history, endMs: 60, bucketMs: 10, buckets: 6, mode, value: (value) => value })
    expect(read('Event')).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    for (const sample of [
      { _tag: 'Value', atMs: 15, value: 4 },
      { _tag: 'Value', atMs: 20, value: 7 },
      { _tag: 'Gap', atMs: 30, durationMs: 5, reason: 'Hidden' },
      { _tag: 'Value', atMs: 35, value: 100 },
      { _tag: 'Value', atMs: 40, value: 102 },
      { _tag: 'Unavailable', atMs: 50, reason: 'Stopped' },
      { _tag: 'Value', atMs: 55, value: 3 },
    ] satisfies readonly Sample<number>[])
      writer.append({ sample })
    expect(read('Gauge')).toEqual([undefined, 7, undefined, 102, undefined, 3])
    expect(read('Event')).toEqual([undefined, 11, undefined, 202, undefined, 3])
    expect(read('Counter')).toEqual([undefined, 3, undefined, 2, undefined, 0])
    writer.append({ sample: { _tag: 'Value', atMs: 60, value: 5 } })
    writer.append({ sample: { _tag: 'Value', atMs: 61, value: 8 } })
    // The overwritten first observation must not be fabricated as a counter baseline.
    expect(history.overflowCount).toBe(1)
    expect(read('Counter')).toEqual([undefined, 0, undefined, 2, undefined, 2])
  })

  it('saturates sums and positive deltas, holds observed zero, and rejects invalid windows', () => {
    const series = makeSeries<number>({ id: 'extrema', label: '', unit: 'count', capacity: 8 })
    const store = makeSeriesStore()
    const writer = store.register({ series })
    const history = store.read({ series })
    const options = {
      history,
      endMs: 20,
      bucketMs: 10,
      buckets: 2,
      mode: 'Event',
      value: (value: number) => value,
    } satisfies Parameters<typeof bucketSeries<number>>[0]
    writer.append({ sample: { _tag: 'Value', atMs: 1, value: Number.MAX_VALUE } })
    writer.append({ sample: { _tag: 'Value', atMs: 2, value: Number.MAX_VALUE } })
    expect(bucketSeries(options)).toEqual([Number.MAX_VALUE, 0])
    writer.append({ sample: { _tag: 'Value', atMs: 3, value: -Number.MAX_VALUE } })
    writer.append({ sample: { _tag: 'Value', atMs: 4, value: Number.MAX_VALUE } })
    expect(bucketSeries({ ...options, mode: 'Counter' })).toEqual([Number.MAX_VALUE, 0])
    writer.append({ sample: { _tag: 'Value', atMs: 11, value: -Number.MAX_VALUE } })
    writer.append({ sample: { _tag: 'Value', atMs: 12, value: -Number.MAX_VALUE } })
    expect(bucketSeries(options)).toEqual([Number.MAX_VALUE, -Number.MAX_VALUE])
    for (const invalid of [
      { endMs: Infinity },
      { endMs: NaN },
      { bucketMs: 0 },
      { bucketMs: -1 },
      { bucketMs: Infinity },
      { buckets: 0 },
      { buckets: 1.5 },
      { bucketMs: Number.MAX_VALUE, buckets: 2 },
    ])
      expect(() => bucketSeries({ ...options, ...invalid })).toThrow(TypeError)
  })

  it('rejects nonrepresentable derived domains instead of turning observed events into zero', () => {
    const series = makeSeries<number>({ id: 'domain', label: '', unit: 'count', capacity: 1 })
    const store = makeSeriesStore()
    store.register({ series }).append({
      sample: { _tag: 'Value', atMs: Number.MAX_VALUE, value: 7 },
    })
    const options = {
      history: store.read({ series }),
      endMs: Number.MAX_VALUE,
      bucketMs: Number.MAX_VALUE / 2,
      buckets: 2,
      mode: 'Event',
      value: (value: number) => value,
    } satisfies Parameters<typeof bucketSeries<number>>[0]
    expect(() => bucketSeries(options)).toThrow(TypeError)
    expect(() =>
      bucketSeries({
        ...options,
        endMs: -Number.MAX_VALUE,
        bucketMs: Number.MAX_VALUE,
        buckets: 1,
      }),
    ).toThrow(TypeError)
  })

  it('consumes a floating-boundary observation once even when adjacent intervals overlap', () => {
    const series = makeSeries<number>({ id: 'overlap', label: '', unit: 'count', capacity: 18 })
    const store = makeSeriesStore()
    const writer = store.register({ series })
    for (const [index, value] of [-3, 0, 0, 0, 0, 0, 30, 29, 30].entries())
      writer.append({ sample: { _tag: 'Value', atMs: index * 0.1, value } })
    const result = bucketSeries({
      history: store.read({ series }),
      endMs: 9 * 0.1 + 0.3,
      bucketMs: 0.3,
      buckets: 7,
      mode: 'Event',
      value: (value) => value,
    })
    // Legacy's index++ assigns the observation at zero to its first eligible endpoint.
    // The next bin's lower edge is slightly below zero but cannot reconsume it.
    // The bin containing 30@0.6, 29@0.7, 30@0.8 excludes 30@0.6 under
    // its original floating lower-bound comparison, leaving the explicit sum 59.
    expect(result).toEqual([undefined, undefined, -3, 0, 0, 59, 0])
  })

  it.effect.prop(
    'matches an independent naive reference on live and immutable retained views',
    [
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: -5, maximum: 30 }))),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
    ],
    ([values, capacity]) =>
      Effect.sync(() => {
        const series = makeSeries<number>({ id: 'property', label: '', unit: 'count', capacity })
        const store = makeSeriesStore()
        const writer = store.register({ series })
        // oxlint-disable-next-line overeng/named-args -- Native Array.forEach callback signature.
        values.forEach((value, index) => {
          const atMs = index * 0.1
          writer.append({
            sample:
              value === -1
                ? { _tag: 'Gap', atMs, durationMs: 0.1, reason: 'MissedFrame' }
                : value === -2
                  ? { _tag: 'Unavailable', atMs, reason: 'MeasurementFailed' }
                  : { _tag: 'Value', atMs, value },
          })
        })
        const snapshot = store.snapshotSeries({ series })
        const frozen = {
          ...snapshot,
          latest: snapshot.samples.at(-1),
          at: (index: number) => snapshot.samples[index],
          length: snapshot.samples.length,
        }
        const endMs = values.length * 0.1 + 0.3
        const spanMs = 7 * 0.3
        // oxlint-disable-next-line overeng/named-args -- Native Array.from callback signature.
        const endpoints = Array.from(
          { length: 7 },
          (_, bin) => endMs - spanMs + ((bin + 1) * spanMs) / 7,
        )
        // Independent search assigns ownership before reduction, rather than
        // reproducing the production scan's advancing cursor.
        const observations = snapshot.samples.map((sample) => ({
          sample,
          bin: endpoints.findIndex((end) => Number.isFinite(end) && sample.atMs <= end),
        }))
        for (const mode of ['Gauge', 'Event', 'Counter'] as const) {
          // oxlint-disable-next-line overeng/named-args -- Native Array.map callback signature.
          const expected = endpoints.map((end, bin) => {
            const observed = observations.filter(({ sample }) => sample.atMs <= end)
            const latest = observed.at(-1)?.sample
            if (latest?._tag !== 'Value') return undefined
            if (mode === 'Gauge') return latest.value
            let sum = 0
            let prior: number | undefined
            for (const { sample, bin: ownerBin } of observed) {
              if (sample._tag !== 'Value') {
                prior = undefined
                continue
              }
              const delta =
                mode === 'Event'
                  ? sample.value
                  : prior === undefined
                    ? 0
                    : Math.max(0, sample.value - prior)
              // Keep the original lower-bound eligibility after assigning each
              // observation to only its first eligible endpoint.
              if (ownerBin === bin && sample.atMs > end - spanMs / 7) sum += delta
              sum = Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, sum))
              prior = sample.value
            }
            return sum
          })
          const options = {
            endMs,
            bucketMs: 0.3,
            buckets: 7,
            mode,
            value: (value: number) => value,
          }
          expect(bucketSeries({ ...options, history: store.read({ series }) })).toEqual(expected)
          expect(bucketSeries({ ...options, history: frozen })).toEqual(expected)
        }
      }),
  )
})
