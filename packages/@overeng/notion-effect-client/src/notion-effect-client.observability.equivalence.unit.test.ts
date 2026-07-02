/**
 * Property-based encoder-equivalence proof for the `notion.*` telemetry migration (SC-R14).
 *
 * The migration re-points notion-effect-client's runtime spans/annotate-bundles/metric-labels at
 * DERIVED encoders from the registered seam contract (`./notion-effect-client.contract.ts`). This test
 * proves "the derivation MECHANISM is correct": for every migrated static operation, the rebuilt
 * dynamic-bridge / annotate bundles, and the raw-metric label struct, the DERIVED product surface
 * (`.operation.encodeSync` / an `OtelAttrs.defineSync` over the imported catalog schemas) produces
 * byte-identical attribute maps to an INDEPENDENT, hand-authored baseline that mirrors the ORIGINAL
 * `internal/otel.ts` / `internal/metrics.ts` shapes (inline `OtelAttr.*` + `OtelOperation.define`).
 *
 * This is a BEHAVIOR-PRESERVING migration: all keys are already namespaced `notion.*`, so the
 * baselines encode the SAME keys the code emitted before the migration — the proof is that the
 * catalog-derived encoder matches that pre-existing shape byte-for-byte (including the `notion.http.method`
 * enum encode, and the exact optionality of `status` / `retry.delay_ms` / `rate_limit.remaining` /
 * `rate_limit.reset_after_ms`).
 *
 * The baseline is authored HERE, from `@overeng/otel-contract`'s runtime primitives directly (NOT from
 * the contract), so the comparison is real and not vacuous. String attrs use `NonEmptyTrimmedString`
 * (derived span labels must not be empty/whitespace); numeric attrs use `NonNegativeInt`.
 */
import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

import {
  NotionDatabasesQueryOperation,
  NotionHttpMethod,
  NotionHttpOperation,
  NotionHttpRetryAttempt,
  NotionHttpRetryAttempts,
  NotionHttpRetryDelayMs,
  NotionHttpRoute,
  NotionHttpStatusCode,
  NotionPagesRetrieveOperation,
  NotionQuotaCost,
  NotionRateLimitPresent,
  NotionRateLimitRemaining,
  NotionRateLimitResetAfterMs,
  NotionRateLimitWaitMs,
} from './notion-effect-client.contract.ts'

// ---- generation-safe primitive schemas (arbitraries) ----
const Str = Schema.NonEmptyTrimmedString
const Flag = Schema.Boolean
const Count = Schema.NonNegativeInt
const Method = Schema.Literal('GET', 'POST', 'PATCH', 'DELETE')

// ---- helpers to author independent baselines from otel-contract runtime primitives ----
const label = () => Schema.NonEmptyString.pipe(OtelAttr.spanLabel())
const drop = () => OtelAttr.drop(Schema.NonEmptyString)
const s = (key: string) => Schema.String.pipe(OtelAttr.key({ key }))
const b = (key: string) => Schema.Boolean.pipe(OtelAttr.key({ key }))
const n = (key: string) => Schema.Number.pipe(OtelAttr.key({ key }))
const method = (key: string) => Method.pipe(OtelAttr.key({ key }))

// ---- independent hand-authored operation baselines (original static-span shape) ----
const databasesQueryBaseline = OtelOperation.define({
  name: 'NotionDatabases.query',
  schema: Schema.Struct({ dataSourceId: s('notion.data_source_id') }),
  label: ({ dataSourceId }) => dataSourceId,
})
const pagesRetrieveBaseline = OtelOperation.define({
  name: 'NotionPages.retrieve',
  schema: Schema.Struct({ pageId: s('notion.page_id') }),
  label: ({ pageId }) => pageId,
})

const opCases = [
  {
    name: 'NotionDatabases.query',
    baseline: databasesQueryBaseline,
    derived: NotionDatabasesQueryOperation.operation,
    input: Schema.Struct({ dataSourceId: Str }),
  },
  {
    name: 'NotionPages.retrieve',
    baseline: pagesRetrieveBaseline,
    derived: NotionPagesRetrieveOperation.operation,
    input: Schema.Struct({ pageId: Str }),
  },
] as const

// ---- independent hand-authored annotate-bundle / dynamic-bridge / metric-label baselines ----
// These mirror the ORIGINAL `internal/otel.ts` / `internal/metrics.ts` field plans exactly.
const httpSpanBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    spanLabel: drop(),
    method: method('notion.http.method'),
    route: s('notion.http.route'),
    operation: s('notion.http.operation'),
  }),
)
const httpRateLimitBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    label: label(),
    method: method('notion.http.method'),
    route: s('notion.http.route'),
    operation: s('notion.http.operation'),
    status: Schema.optional(n('notion.http.status_code')),
    attempt: n('notion.http.retry.attempt'),
    attempts: n('notion.http.retry.attempts'),
    retryDelayMs: Schema.optional(n('notion.http.retry.delay_ms')),
    quotaCost: n('notion.quota.cost'),
    rateLimitPresent: b('notion.rate_limit.present'),
    rateLimitRemaining: Schema.optional(n('notion.rate_limit.remaining')),
    rateLimitResetAfterMs: Schema.optional(n('notion.rate_limit.reset_after_ms')),
  }),
)
const httpRateLimitWaitBaseline = OtelAttrs.defineSync(
  Schema.Struct({ rateLimitWaitMs: n('notion.rate_limit.wait_ms') }),
)
const metricLabelsBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    method: OtelAttr.literal('notion.http.method', 'GET', 'POST', 'PATCH', 'DELETE'),
    operation: OtelAttr.string({
      key: 'notion.http.operation',
      metadata: { cardinality: 'bounded' },
    }),
  }),
)

const bundleCases = [
  {
    name: 'http-span-attrs (NotionHttp.<METHOD> dynamic bridge)',
    baseline: httpSpanBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        spanLabel: drop(),
        method: NotionHttpMethod,
        route: NotionHttpRoute,
        operation: NotionHttpOperation,
      }),
    ),
    input: Schema.Struct({ spanLabel: Str, method: Method, route: Str, operation: Str }),
  },
  {
    name: 'http-rate-limit-attrs (annotate bundle)',
    baseline: httpRateLimitBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        label: label(),
        method: NotionHttpMethod,
        route: NotionHttpRoute,
        operation: NotionHttpOperation,
        status: Schema.optional(NotionHttpStatusCode),
        attempt: NotionHttpRetryAttempt,
        attempts: NotionHttpRetryAttempts,
        retryDelayMs: Schema.optional(NotionHttpRetryDelayMs),
        quotaCost: NotionQuotaCost,
        rateLimitPresent: NotionRateLimitPresent,
        rateLimitRemaining: Schema.optional(NotionRateLimitRemaining),
        rateLimitResetAfterMs: Schema.optional(NotionRateLimitResetAfterMs),
      }),
    ),
    input: Schema.Struct({
      label: Str,
      method: Method,
      route: Str,
      operation: Str,
      status: Schema.optional(Count),
      attempt: Count,
      attempts: Count,
      retryDelayMs: Schema.optional(Count),
      quotaCost: Count,
      rateLimitPresent: Flag,
      rateLimitRemaining: Schema.optional(Count),
      rateLimitResetAfterMs: Schema.optional(Count),
    }),
  },
  {
    name: 'http-rate-limit-wait-attrs (annotate bundle)',
    baseline: httpRateLimitWaitBaseline,
    derived: OtelAttrs.defineSync(Schema.Struct({ rateLimitWaitMs: NotionRateLimitWaitMs })),
    input: Schema.Struct({ rateLimitWaitMs: Count }),
  },
  {
    name: 'metric-labels (notion_http_*_total pressure counters)',
    baseline: metricLabelsBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({ method: NotionHttpMethod, operation: NotionHttpOperation }),
    ),
    input: Schema.Struct({ method: Method, operation: Str }),
  },
] as const

describe('notion.* derived operation encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  for (const c of opCases) {
    it.prop(
      `${c.name}: derived .operation.encodeSync ≡ baseline.encodeSync`,
      [c.input],
      ([value]) => {
        const baseline = (c.baseline as OtelOperationDefinition<never>).encodeSync(value as never)
        const derived = (c.derived as OtelOperationDefinition<never>).encodeSync(value as never)
        expect(derived).toStrictEqual(baseline)
        expect(typeof derived['span.label']).toBe('string')
      },
      { fastCheck: { numRuns: 200 } },
    )

    it(`${c.name}: derived and baseline agree on span name + attribute keys`, () => {
      expect(c.derived.metadata.name).toBe(c.baseline.metadata.name)
      expect([...c.derived.metadata.attributeKeys].toSorted()).toStrictEqual(
        [...c.baseline.metadata.attributeKeys].toSorted(),
      )
    })
  }
})

describe('notion.* derived annotate/metric-label encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  for (const c of bundleCases) {
    it.prop(
      `${c.name}: derived .encodeSync ≡ baseline.encodeSync`,
      [c.input],
      ([value]) => {
        const baseline = c.baseline.encodeSync(value as never)
        const derived = c.derived.encodeSync(value as never)
        expect(derived).toStrictEqual(baseline)
      },
      { fastCheck: { numRuns: 200 } },
    )

    it(`${c.name}: derived and baseline agree on attribute keys`, () => {
      expect([...c.derived.keys].toSorted()).toStrictEqual([...c.baseline.keys].toSorted())
    })
  }
})
