/**
 * Otelite round-trip assertion helpers for the Buck evidence lane.
 *
 * Thin, evidence-specific vocabulary over `@overeng/utils-dev/otelite`'s
 * `expectTrace` / `expectMetrics` DSL:
 *
 * - {@link expectExactlyOneInvocation} — the "exactly-one CLIENT
 *   `buck.invocation` span parented under the harness root" shape (R04).
 * - {@link expectNoRichSpans} — NO_VERDICT structure: zero rich-tier spans in
 *   the trace (R03/R11).
 * - {@link guardMetricCardinality} — scans EVERY captured metric row and fails
 *   if any attribute key falls outside the bounded vocabulary (R06). This is
 *   the enforcing negative scan; it runs over all rows precisely so a future
 *   label leak cannot hide behind an unasserted metric name.
 * - {@link readSpanLinksFromCapture} — extracts W3C span LINKS from the raw
 *   otelite traces capture file (flat inspect rows drop links).
 */
import { Schema } from 'effect'

import {
  expectTrace,
  type MetricRow,
  type SpanRow,
  type TraceExpect,
} from '@overeng/utils-dev/otelite'

import { SpanAttrKeys, SpanNames } from './telemetry.ts'

/**
 * Assert exactly one invocation span, optionally parented under a specific
 * span id. Returns the matched row so tests can assert attributes further.
 */
export const expectExactlyOneInvocation = ({
  options = {},
  trace,
}: {
  readonly options?: { readonly parentSpanId?: string | undefined } | undefined
  readonly trace: TraceExpect
}): SpanRow => {
  const invocation = trace.expectOne({ name: SpanNames.invocation })
  const kind = invocation.attrs[SpanAttrKeys.commandKind]
  const status = invocation.attrs[SpanAttrKeys.resultClass]
  if (kind === undefined || status === undefined) {
    throw new Error(
      `buck.invocation span missing command/result class attrs: ${JSON.stringify(invocation.attrs)}`,
    )
  }
  const parentSpanId = options.parentSpanId
  if (parentSpanId !== undefined && invocation.parent_span_id !== parentSpanId) {
    throw new Error(
      `buck.invocation parent_span_id ${invocation.parent_span_id} !== expected ${options.parentSpanId}`,
    )
  }
  return invocation
}

/** Names that only the rich event-log tier may ever produce. */
const RichSpanNames = [SpanNames.action, 'buck.artifact.materialized'] as const

/** NO_VERDICT structure: no span derived from the unsupported/absent rich tier exists. */
export const expectNoRichSpans = (trace: TraceExpect): void => {
  for (const name of RichSpanNames) {
    const matches = trace.findByName(name)
    if (matches.length > 0) {
      throw new Error(
        `Expected zero '${name}' spans for NO_VERDICT evidence, found ${matches.length}`,
      )
    }
  }
}

/** The ONLY attribute keys allowed on any buck2 evidence metric data point. */
export const BoundedMetricLabelKeys: ReadonlySet<string> = new Set([
  'operation-kind',
  'result-class',
  'platform-class',
  'cache-class',
])

interface CardinalityViolation {
  readonly key: string
  readonly metric: string
  readonly value?: string | undefined
}

/**
 * Enforcing negative scan (BUCK.OBS-R06): EVERY captured data point of the
 * evidence metric family (`buck2_*`) must have its entire attribute key set
 * within {@link BoundedMetricLabelKeys}. Invocation IDs, digests, paths,
 * target labels, or ANY future label can only appear here by breaking this
 * scan. Non-evidence runtime metrics emitted by the surrounding process
 * (e.g. effect runtime gauges) are outside the contract and skipped.
 */
export const guardMetricCardinality = (metricRows: ReadonlyArray<MetricRow>): void => {
  const violations: Array<CardinalityViolation> = []
  for (const row of metricRows) {
    if (row.name.startsWith('buck2_') === false) continue
    for (const [key, value] of Object.entries(row.attrs)) {
      if (BoundedMetricLabelKeys.has(key) === false) {
        violations.push({ key, metric: row.name, value })
      }
    }
  }
  if (violations.length > 0) {
    const rendered = violations
      .map((violation) =>
        violation.value === undefined
          ? `${violation.metric}[${violation.key}]`
          : `${violation.metric}[${violation.key}]=${violation.value}`,
      )
      .join(', ')
    throw new Error(
      `Metric cardinality violation: unbounded attribute keys found outside ${[
        ...BoundedMetricLabelKeys,
      ].join('|')}: ${rendered}`,
    )
  }
}

const CaptureLine = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      scopeSpans: Schema.Array(
        Schema.Struct({
          spans: Schema.Array(
            Schema.Struct({
              links: Schema.optional(
                Schema.Array(Schema.Struct({ spanId: Schema.String, traceId: Schema.String })),
              ),
              name: Schema.String,
              spanId: Schema.String,
              traceId: Schema.String,
            }),
          ),
        }),
      ),
    }),
  ),
})

/** One W3C span link recovered from the raw capture file, with its owning span. */
export interface CapturedLink {
  readonly linkSpanId: string
  readonly linkTraceId: string
  readonly spanName: string
}

/** Parse an otelite raw traces capture file and return every span's links. */
export const readSpanLinksFromCapture = (captureText: string): ReadonlyArray<CapturedLink> => {
  const links: Array<CapturedLink> = []
  for (const line of captureText.split('\n')) {
    if (line.trim() === '') continue
    const request = Schema.decodeUnknownSync(CaptureLine)(JSON.parse(line))
    for (const resourceSpan of request.resourceSpans) {
      for (const scopeSpan of resourceSpan.scopeSpans) {
        for (const span of scopeSpan.spans) {
          for (const link of span.links ?? []) {
            links.push({
              linkSpanId: link.spanId,
              linkTraceId: link.traceId,
              spanName: span.name,
            })
          }
        }
      }
    }
  }
  return links
}

// Re-exported so tests construct expectations without reaching into otelite directly.
export { expectTrace }
