/**
 * Deterministic e2e coverage for the rate-limit PRESSURE signals (decision 0017
 * Half 2, #775). The fake gateway in `@overeng/notion-datasource-sync` never
 * exercises the HTTP path, so these signals are otherwise only observable live.
 * Here a STATEFUL fault-injecting HTTP stub (the existing `createMockHttpClient`
 * driven by a per-call response sequence) deterministically drives:
 *
 *  1. The retry path: a 429 + `Retry-After` then a 200 — proving the HTTP-attempt
 *     count = 2 (initial + one retry), `retry_after` is recorded, and the request
 *     span carries the retry/rate-limit attrs.
 *  2. The throttle-wait path: this is ORTHOGONAL to retries — `NotionThrottle.apply`
 *     wraps the WHOLE retry loop, so exactly ONE token is consumed per logical
 *     request BEFORE attempt 1. A single isolated request through a fresh bucket
 *     therefore waits ~0ms no matter how many 429s it retries. To produce a real
 *     wait we DRAIN the bucket with a prior request (rps=1, burst=1), then the
 *     measured request blocks ~1 interval acquiring its token (driven under
 *     TestClock, mirroring throttle.unit.test.ts).
 *
 * Metrics are global Effect singletons, so every counter/histogram assertion is a
 * DELTA (snapshot before vs after) — never an absolute value — so cross-test
 * accumulation in the same process can't make these flaky.
 *
 * This file is `*.e2e.test.ts`, exempt from `overeng/no-raw-otel-primitives`, so it
 * may read raw `Metric` values to assert the OtelMetric-emitted counters moved.
 */
import { HttpClient } from 'effect'
import { Effect, Fiber, Metric, Redacted, Schema, TestClock, Tracer } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { NotionConfig } from '../config.ts'
import { createMockHttpClient, type MockResponse, sampleResponses } from '../test/test-utils.ts'
import { get } from './http.ts'
import { NotionRateLimitMetricBridges } from './metrics.ts'
import { NotionThrottle, NotionThrottleLive } from './throttle.ts'

const TestSchema = Schema.Struct({
  object: Schema.Literal('database'),
  id: Schema.String,
})

type RecordedSpan = { readonly name: string; readonly attributes: Record<string, unknown> }

const makeRecordingTracer = (): {
  readonly tracer: Tracer.Tracer
  readonly spans: ReadonlyArray<RecordedSpan>
} => {
  const spans: RecordedSpan[] = []
  return {
    spans,
    tracer: Tracer.make({
      span: (name, parent, context, links, startTime, kind) => {
        const attributes = new Map<string, unknown>()
        const recorded: RecordedSpan = { name, attributes: {} }
        spans.push(recorded)
        return {
          _tag: 'Span',
          name,
          spanId: `span-${spans.length}`,
          traceId: 'trace-rl-e2e',
          parent,
          context,
          status: { _tag: 'Started', startTime },
          attributes,
          links,
          sampled: true,
          kind,
          end: () => {},
          attribute: (key, value) => {
            attributes.set(key, value)
            recorded.attributes[key] = value
          },
          event: () => {},
          addLinks: () => {},
        }
      },
      context: (f) => f(),
    }),
  }
}

/** A stateful fault injector: returns each response in sequence, repeating the last. */
const sequencedClient = (responses: ReadonlyArray<MockResponse>) => {
  let call = 0
  const client = createMockHttpClient(() => {
    const response = responses[Math.min(call, responses.length - 1)]
    call += 1
    return response ?? { status: 200, body: sampleResponses.database }
  })
  return { client, calls: () => call }
}

type CounterBridge<S> = {
  readonly metric: Metric.Metric.Counter<number>
  readonly definition: {
    readonly trustedTagPairs: (labels: S) => Effect.Effect<ReadonlyArray<readonly [string, string]>>
  }
}

type HistogramBridge<S> = {
  readonly metric: Metric.Metric.Histogram<number>
  readonly definition: {
    readonly trustedTagPairs: (labels: S) => Effect.Effect<ReadonlyArray<readonly [string, string]>>
  }
}

/** Read a counter delta by tagging the bridge's base metric with the encoded labels. */
const counterCount = <S>(bridge: CounterBridge<S>, labels: S): Effect.Effect<number> =>
  Effect.gen(function* () {
    const pairs = yield* bridge.definition.trustedTagPairs(labels)
    let metric: Metric.Metric.Counter<number> = bridge.metric
    for (const [key, value] of pairs) metric = Metric.tagged(metric, key, value)
    const state = yield* Metric.value(metric)
    return state.count
  })

const histogramState = <S>(
  bridge: HistogramBridge<S>,
  labels: S,
): Effect.Effect<{ readonly count: number; readonly sum: number }> =>
  Effect.gen(function* () {
    const pairs = yield* bridge.definition.trustedTagPairs(labels)
    let metric: Metric.Metric.Histogram<number> = bridge.metric
    for (const [key, value] of pairs) metric = Metric.tagged(metric, key, value)
    const state = yield* Metric.value(metric)
    return { count: state.count, sum: state.sum }
  })

Vitest.describe('rate-limit pressure signals (decision 0017 Half 2)', () => {
  Vitest.it.scoped(
    'a 429-then-200 sequence records 2 HTTP attempts, a retry_after, and retry span attrs',
    () =>
      Effect.gen(function* () {
        const labels = { method: 'GET', operation: 'databases.object' } as const

        const attemptsBefore = yield* counterCount(
          NotionRateLimitMetricBridges.httpAttemptsTotal,
          labels,
        )
        const retryAfterBefore = yield* counterCount(
          NotionRateLimitMetricBridges.retryAfterTotal,
          labels,
        )
        const retryAfterMsBefore = yield* counterCount(
          NotionRateLimitMetricBridges.retryAfterMsTotal,
          labels,
        )

        const { client, calls } = sequencedClient([
          {
            status: 429,
            body: sampleResponses.error(429, 'rate_limited', 'Rate limited'),
            headers: { 'retry-after': '3', 'x-ratelimit-remaining': '0' },
          },
          { status: 200, body: sampleResponses.database },
        ])
        const trace = makeRecordingTracer()

        const fiber = yield* get({ path: '/databases/123', responseSchema: TestSchema }).pipe(
          Effect.provideService(NotionConfig, {
            authToken: Redacted.make('test-token'),
            retryEnabled: true,
            maxRetries: 3,
            retryBaseDelay: 1000,
          }),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.withTracer(trace.tracer),
          Effect.fork,
        )
        yield* TestClock.adjust('60 seconds')
        const result = yield* Fiber.join(fiber)

        expect(result.id).toBe('db-123')
        // HTTP-attempt count = 2: initial 429 + one retry to 200.
        expect(calls()).toBe(2)

        const attemptsAfter = yield* counterCount(
          NotionRateLimitMetricBridges.httpAttemptsTotal,
          labels,
        )
        const retryAfterAfter = yield* counterCount(
          NotionRateLimitMetricBridges.retryAfterTotal,
          labels,
        )
        const retryAfterMsAfter = yield* counterCount(
          NotionRateLimitMetricBridges.retryAfterMsTotal,
          labels,
        )

        // The HTTP-attempt PRESSURE counter moved by 2 (initial + retry) — DISTINCT
        // from the logical-request budget ceiling, which would count this as 1.
        expect(attemptsAfter - attemptsBefore).toBe(2)
        // The retry honored the server `Retry-After` once, summing 3000ms.
        expect(retryAfterAfter - retryAfterBefore).toBe(1)
        expect(retryAfterMsAfter - retryAfterMsBefore).toBe(3000)

        const span = trace.spans.find((candidate) => candidate.name === 'NotionHttp.GET')
        expect(span).toBeDefined()
        // The request span carries the retry-pressure attrs. `retry.delay_ms` is
        // the durable evidence of the 429 retry decision (the server `Retry-After`
        // floored the backoff to 3000ms). `retry.attempts` reaches 2 — the request
        // span's annotations are last-write-wins, and the final (successful) attempt
        // stamps the cumulative attempt count.
        expect(span?.attributes['notion.http.retry.delay_ms']).toBe(3000)
        expect(span?.attributes['notion.http.retry.attempts']).toBe(2)
      }),
  )

  Vitest.it.scoped(
    'a request blocked behind a drained throttle bucket records rate_limit_wait_ms on span and histogram',
    () =>
      Effect.gen(function* () {
        const histoBefore = yield* histogramState(NotionRateLimitMetricBridges.rateLimitWaitMs, {})

        const { client } = sequencedClient([{ status: 200, body: sampleResponses.database }])
        const trace = makeRecordingTracer()

        // rps=1, burst=1 ⇒ one token immediately, the next after a 1000ms interval.
        // `executeRequest` consults the SAME `NotionThrottle` from the layer, so a
        // prior `throttle.apply(void)` drains the only token and the request must
        // wait one interval for the bucket to refill before its own acquire.
        const program = Effect.gen(function* () {
          const throttle = yield* NotionThrottle
          yield* throttle.apply(Effect.void)
          return yield* get({ path: '/databases/123', responseSchema: TestSchema })
        })

        const fiber = yield* program.pipe(
          Effect.provideService(NotionConfig, {
            authToken: Redacted.make('test-token'),
            retryEnabled: false,
          }),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provide(NotionThrottleLive({ requestsPerSecond: 1, burst: 1 })),
          Effect.withTracer(trace.tracer),
          Effect.fork,
        )
        yield* TestClock.adjust('5 seconds')
        yield* Fiber.join(fiber)

        const span = trace.spans.find((candidate) => candidate.name === 'NotionHttp.GET')
        expect(span).toBeDefined()
        expect(span?.attributes['notion.rate_limit.wait_ms']).toBeGreaterThan(0)

        const histoAfter = yield* histogramState(NotionRateLimitMetricBridges.rateLimitWaitMs, {})
        // The wait histogram recorded at least the measured request's wait.
        expect(histoAfter.count - histoBefore.count).toBeGreaterThanOrEqual(1)
        expect(histoAfter.sum - histoBefore.sum).toBeGreaterThan(0)
      }),
  )
})
