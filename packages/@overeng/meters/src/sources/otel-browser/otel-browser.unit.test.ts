import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'
import { vi } from 'vitest'

import { SpanRing } from '@overeng/otel-browser'

import { makeSeries } from '../../series/index.ts'
import { testPlatform } from '../../session/_test-platform.ts'
import { makeMeters } from '../../session/index.ts'
import type { SpanSummary } from '../spans/index.ts'
import { otelBrowserSpansSource } from './index.ts'

const span: SpanRing.RingSpan = {
  name: 'not delivered',
  label: 'not delivered',
  traceId: 'not delivered',
  spanId: 'not delivered',
  parentSpanId: undefined,
  startMs: 5000,
  durationMs: 7,
  status: 'ok',
  sampled: false,
  attributes: { secret: 'not delivered' },
}

describe('optional host SpanRing adapter', () => {
  it.effect(
    'counts unthrottled unsampled completions, not retained history, and releases its hook',
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            vi.runAllTimers()
            vi.useRealTimers()
          }),
        )
        const ring = SpanRing.make({ capacity: 1 })
        ring.push(span)
        const host = testPlatform()
        const series = makeSeries<SpanSummary>({
          id: 'spans',
          label: 'Spans',
          unit: 'ms',
          capacity: 2,
        })
        const source = otelBrowserSpansSource({ id: 'spans', series, ring })
        const meters = makeMeters({ platform: host.platform, sources: [source] })
        const scope = yield* Scope.make()
        yield* Scope.provide(meters.start, scope)
        expect(meters.store.read({ series }).latest).toBeUndefined()
        ring.push(span)
        host.advance(10)
        ring.push({ ...span, status: 'interrupted' })
        ring.push({ ...span, status: 'error', sampled: true })
        expect(source.evidence.counters?.()).toEqual({ 'spans.completions': 3, 'spans.errors': 2 })
        expect(meters.store.read({ series }).latest).toEqual({
          _tag: 'Value',
          atMs: 10,
          value: { _tag: 'SpanSummary', durationMs: 7, status: 'Error', completions: 3, errors: 2 },
        })
        expect(host.requests).toBe(0)
        yield* Scope.close(scope, Exit.succeed(undefined))
        const revision = meters.store.getRevision()
        ring.push(span)
        expect(source.evidence.counters?.()).toEqual({ 'spans.completions': 3, 'spans.errors': 2 })
        expect(meters.store.getRevision()).toBe(revision)
      }).pipe(Effect.scoped),
  )
  it.effect('reports missing ring as not configured', () =>
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
        sources: [otelBrowserSpansSource({ id: 'spans', series })],
      })
      yield* meters.start
      expect(meters.store.read({ series }).latest).toEqual({
        _tag: 'Unavailable',
        atMs: 0,
        reason: 'NotConfigured',
      })
    }).pipe(Effect.scoped),
  )
})
