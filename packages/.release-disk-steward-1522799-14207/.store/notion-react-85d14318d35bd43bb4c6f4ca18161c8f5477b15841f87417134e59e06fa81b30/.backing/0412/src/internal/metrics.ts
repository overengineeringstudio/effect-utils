/**
 * Rate-limit PRESSURE metrics for the Notion HTTP client (decision 0017 Half 2,
 * #775). These answer "what did rate-limit pressure cost us" and are explicitly
 * DISTINCT from Half 1's logical-request budget CEILING (one `notion.api.request`
 * span per logical request, asserted test-side in `@overeng/notion-datasource-sync`):
 *
 * - `notion_http_attempts_total` counts ACTUAL HTTP attempts INCLUDING retries,
 *   so it diverges from the logical-request count precisely under retry pressure.
 * - `notion_http_retry_after_total` / `_ms_total` count and sum the server-advised
 *   `Retry-After` backpressure (only the 429 / retry-after path contributes).
 * - `notion_rate_limit_wait_ms` is the time a logical request was BLOCKED acquiring
 *   a throttle token (the genuinely-new signal — see {@link throttle.ts}).
 *
 * All metrics route through `@overeng/otel-contract` `OtelMetric` (the
 * `overeng/no-raw-otel-primitives` lint bans raw Effect `Metric` in `src/**`).
 * Labels are kept BOUNDED (HTTP method + sanitized operation key — never ids/urls)
 * so cardinality stays low; the wait histogram is UNLABELED because the throttle
 * seam is a generic `(effect) => effect` wrapper with no route in scope (the
 * per-operation dimension already rides the `NotionHttp.<METHOD>` span).
 */
import { Schema } from 'effect'

import { OtelMetric } from '@overeng/otel-contract'

import { NotionHttpMethod, NotionHttpOperation } from '../notion-effect-client.contract.ts'

/**
 * HTTP method + sanitized operation key — both bounded-cardinality. The label schemas are DERIVED
 * from the `notion.*` seam catalog (`../notion-effect-client.contract.ts`), the single SSOT for these
 * keys (SC-R13/R14). The keys are already namespaced (`notion.http.*`), so there is NO wire rename —
 * this is a byte-identical re-point (proven by the colocated equivalence property test). These metrics
 * stay raw `OtelMetric` (rather than registry `metric()` signals) to preserve the counters' ABSENT
 * unit, which the `metric()` DSL cannot express; promoting them to signals is a flagged follow-up.
 */
const HttpPressureLabels = Schema.Struct({
  method: NotionHttpMethod,
  operation: NotionHttpOperation,
})

/** Latency buckets (ms) for the throttle-token wait, matching common backpressure scales. */
const WaitMsBoundaries = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000,
] as const

/** The rate-limit PRESSURE metric contracts (counters + the wait histogram). */
export const NotionRateLimitMetrics = {
  /**
   * HTTP-attempt counter (`notion_http_attempts_total`), labelled method+operation.
   * Incremented on EVERY real HTTP attempt (initial + each retry), so it diverges
   * from the logical-request ceiling exactly under retry storms.
   */
  httpAttemptsTotal: OtelMetric.counter({
    name: 'notion_http_attempts_total',
    description:
      'Actual Notion HTTP attempts including retries, by method and operation (rate-limit pressure — distinct from the logical-request budget).',
    labels: HttpPressureLabels,
  }),
  /**
   * `Retry-After` occurrence counter (`notion_http_retry_after_total`), labelled
   * method+operation. Incremented once per retry decision that carries a
   * server-advised `Retry-After` (the 429 backpressure path).
   */
  retryAfterTotal: OtelMetric.counter({
    name: 'notion_http_retry_after_total',
    description: 'Retry decisions honoring a server `Retry-After`, by method and operation.',
    labels: HttpPressureLabels,
  }),
  /**
   * Summed `Retry-After` delay (`notion_http_retry_after_ms_total`), labelled
   * method+operation. Accumulates the milliseconds spent waiting on
   * server-advised `Retry-After` so total backpressure time is observable.
   */
  retryAfterMsTotal: OtelMetric.counter({
    name: 'notion_http_retry_after_ms_total',
    description: 'Total milliseconds spent honoring server `Retry-After`, by method and operation.',
    unit: 'ms',
    labels: HttpPressureLabels,
  }),
  /**
   * Throttle-token wait histogram (`notion_rate_limit_wait_ms`). The time a logical
   * request was blocked acquiring a token from {@link NotionThrottle}. UNLABELED —
   * the throttle wrapper has no route in scope; the per-op slice rides the request
   * span attribute of the same name.
   */
  rateLimitWaitMs: OtelMetric.histogram({
    name: 'notion_rate_limit_wait_ms',
    description: 'Time blocked acquiring a Notion request-throttle token (ms).',
    unit: 'ms',
    boundaries: WaitMsBoundaries,
    labels: Schema.Struct({}),
  }),
} as const

/** Effect bridges for emission via `trustedIncrement` / `trustedRecord`. */
export const NotionRateLimitMetricBridges = {
  httpAttemptsTotal: OtelMetric.effect.counter(NotionRateLimitMetrics.httpAttemptsTotal),
  retryAfterTotal: OtelMetric.effect.counter(NotionRateLimitMetrics.retryAfterTotal),
  retryAfterMsTotal: OtelMetric.effect.counter(NotionRateLimitMetrics.retryAfterMsTotal),
  rateLimitWaitMs: OtelMetric.effect.histogram(NotionRateLimitMetrics.rateLimitWaitMs),
} as const
