import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'

import { makeSeries } from '../../series/index.ts'
import { testPlatform } from '../../session/_test-platform.ts'
import { makeMeters } from '../../session/index.ts'
import { makeSpanCompletionSink, spansSource, type SpanSummary } from './index.ts'

describe('content-free span aggregation', () => {
  it.effect(
    'retains only completion evidence and exact totals beyond eviction, then removes hooks',
    () =>
      Effect.gen(function* () {
        const host = testPlatform()
        const series = makeSeries<SpanSummary>({
          id: 'spans',
          label: 'Spans',
          unit: 'ms',
          capacity: 1,
        })
        const sink = makeSpanCompletionSink()
        const source = spansSource({ id: 'spans', series, feed: sink.feed })
        const meters = makeMeters({ platform: host.platform, sources: [source] })
        sink.complete({ atMs: 1, durationMs: 1, status: 'Success' })
        expect(source.evidence.counters?.()).toEqual({ 'spans.completions': 0, 'spans.errors': 0 })
        const scope = yield* Scope.make()
        yield* Scope.provide(meters.start, scope)
        const content = {
          atMs: 5000,
          durationMs: 2,
          status: 'Success' as const,
          name: 'private span',
          attributes: { secret: 'not retained' },
          traceId: 'not retained',
        }
        sink.complete(content)
        host.advance(10)
        sink.complete({ atMs: 3, durationMs: 4, status: 'Error' })
        expect(meters.store.snapshotSeries({ series }).samples).toEqual([
          {
            _tag: 'Value',
            atMs: 10,
            value: {
              _tag: 'SpanSummary',
              durationMs: 4,
              status: 'Error',
              completions: 2,
              errors: 1,
            },
          },
        ])
        expect(source.evidence.counters?.()).toEqual({ 'spans.completions': 2, 'spans.errors': 1 })
        expect(host.requests).toBe(0)
        yield* Scope.close(scope, Exit.succeed(undefined))
        const revision = meters.store.getRevision()
        sink.complete({ atMs: 4, durationMs: 5, status: 'Success' })
        expect(meters.store.getRevision()).toBe(revision)
        expect(source.evidence.counters?.()).toEqual({ 'spans.completions': 2, 'spans.errors': 1 })
        const next = yield* Scope.make()
        yield* Scope.provide(meters.start, next)
        sink.complete({ atMs: 5, durationMs: 6, status: 'Success' })
        expect(source.evidence.counters?.()).toEqual({ 'spans.completions': 3, 'spans.errors': 1 })
        yield* Scope.close(next, Exit.succeed(undefined))
      }),
  )
  it.effect('reports absent host seam as not configured', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const series = makeSeries<SpanSummary>({
        id: 'spans',
        label: 'Spans',
        unit: 'ms',
        capacity: 1,
      })
      const meters = makeMeters({
        platform: host.platform,
        sources: [spansSource({ id: 'spans', series })],
      })
      yield* meters.start
      expect(meters.store.read({ series }).latest).toEqual({
        _tag: 'Unavailable',
        atMs: 0,
        reason: 'NotConfigured',
      })
      expect(host.requests).toBe(0)
    }).pipe(Effect.scoped),
  )
})
