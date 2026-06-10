import { Schema } from 'effect'

/**
 * `Schema` structs for the otelite CLI JSON contract (the seven
 * `otelite.<name>/v1` output schemas). The CLI's JSON output is the single
 * source of truth; these decode it into typed values. Field shapes are
 * golden-locked by the otelite conformance tests.
 *
 * Conventions confirmed against real binary output:
 * - `attrs` is always a flat `Record<string, string>` (the capture model
 *   flattens every OTLP `AnyValue` to its string form; non-scalars become `""`).
 * - ids and `*_unix_nano` timestamps are strings (the OTel JSON dialect).
 * - numeric metric values are JSON numbers.
 * - `trace_id` / `span_id` / `parent_span_id` are nullable on row schemas.
 */

const Attrs = Schema.Record({ key: Schema.String, value: Schema.String }).annotations({
  identifier: 'Otelite.Attrs',
})

/** Endpoints the receiver bound (base URLs). */
export const Endpoints = Schema.Struct({
  http: Schema.String,
  grpc: Schema.String,
}).annotations({ identifier: 'Otelite.Endpoints' })

/**
 * `otelite.endpoints/v1` — the FIRST stdout line `capture` emits the instant
 * both receivers bind. Distinct from {@link Endpoints} (the summary's `http`/
 * `grpc` sub-object): this is the standalone tagged event the in-process parent
 * decodes to learn the ephemeral endpoints + out-dir with no string scraping.
 */
export const EndpointsEvent = Schema.Struct({
  schema: Schema.Literal('otelite.endpoints/v1'),
  http: Schema.String,
  grpc: Schema.String,
  out: Schema.String,
}).annotations({ identifier: 'Otelite.EndpointsEvent' })
export type EndpointsEvent = typeof EndpointsEvent.Type

/** Per-signal capture file paths. */
export const CaptureFiles = Schema.Struct({
  traces: Schema.String,
  metrics: Schema.String,
  logs: Schema.String,
}).annotations({ identifier: 'Otelite.CaptureFiles' })

/** Per-signal received-record counts. */
export const Counts = Schema.Struct({
  spans: Schema.Number,
  metrics: Schema.Number,
  logs: Schema.Number,
}).annotations({ identifier: 'Otelite.Counts' })

/** The child process otelite ran (`run` only; `null` for `capture`). */
export const Child = Schema.Struct({
  argv: Schema.Array(Schema.String),
  exit_code: Schema.Int,
}).annotations({ identifier: 'Otelite.Child' })

/** `otelite.summary/v1` — emitted by `run` and `capture`. */
export const Summary = Schema.Struct({
  schema: Schema.Literal('otelite.summary/v1'),
  out: Schema.String,
  endpoints: Endpoints,
  files: CaptureFiles,
  counts: Counts,
  child: Schema.NullOr(Child),
  duration_ms: Schema.Number,
}).annotations({ identifier: 'Otelite.Summary' })
export type Summary = typeof Summary.Type

/** `otelite.span/v1` — a flattened span row from `inspect --signal traces`. */
export const SpanRow = Schema.Struct({
  schema: Schema.Literal('otelite.span/v1'),
  service: Schema.String,
  name: Schema.String,
  trace_id: Schema.NullOr(Schema.String),
  span_id: Schema.NullOr(Schema.String),
  parent_span_id: Schema.NullOr(Schema.String),
  start_unix_nano: Schema.String,
  end_unix_nano: Schema.String,
  duration_ms: Schema.Number,
  status_code: Schema.Int,
  attrs: Attrs,
}).annotations({ identifier: 'Otelite.SpanRow' })
export type SpanRow = typeof SpanRow.Type

/** `otelite.metric/v1` — a flattened metric data point from `inspect --signal metrics`. */
export const MetricRow = Schema.Struct({
  schema: Schema.Literal('otelite.metric/v1'),
  service: Schema.String,
  name: Schema.String,
  type: Schema.String,
  unit: Schema.String,
  value: Schema.optional(Schema.Number),
  time_unix_nano: Schema.String,
  start_time_unix_nano: Schema.optional(Schema.String),
  temporality: Schema.optional(Schema.String),
  monotonic: Schema.optional(Schema.Boolean),
  attrs: Attrs,
}).annotations({ identifier: 'Otelite.MetricRow' })
export type MetricRow = typeof MetricRow.Type

/** `otelite.log/v1` — a flattened log record from `inspect --signal logs`. */
export const LogRow = Schema.Struct({
  schema: Schema.Literal('otelite.log/v1'),
  service: Schema.String,
  scope: Schema.NullOr(Schema.String),
  body: Schema.String,
  severity_number: Schema.Int,
  severity_text: Schema.String,
  trace_id: Schema.NullOr(Schema.String),
  span_id: Schema.NullOr(Schema.String),
  time_unix_nano: Schema.String,
  attrs: Attrs,
}).annotations({ identifier: 'Otelite.LogRow' })
export type LogRow = typeof LogRow.Type

// --- Summary report objects (`--summary`) ---

const DurationGroup = Schema.Struct({
  key: Schema.String,
  span_count: Schema.Number,
  inclusive_duration_ms: Schema.Number,
  exclusive_duration_ms: Schema.Number,
  instant_event_span_count: Schema.Number,
  zero_duration_span_count: Schema.Number,
}).annotations({ identifier: 'Otelite.DurationGroup' })

const SlowSpan = Schema.Struct({
  span_id: Schema.String,
  parent_span_id: Schema.NullOr(Schema.String),
  name: Schema.String,
  service_name: Schema.String,
  label: Schema.NullOr(Schema.String),
  inclusive_duration_ms: Schema.Number,
  exclusive_duration_ms: Schema.Number,
  relative_start_ms: Schema.Number,
  instant_event: Schema.Boolean,
}).annotations({ identifier: 'Otelite.SlowSpan' })

const ErrorSpan = Schema.Struct({
  span_id: Schema.String,
  name: Schema.String,
  service_name: Schema.String,
  label: Schema.NullOr(Schema.String),
  inclusive_duration_ms: Schema.Number,
  exclusive_duration_ms: Schema.Number,
  instant_event: Schema.Boolean,
}).annotations({ identifier: 'Otelite.ErrorSpan' })

/** `otelite.trace-summary/v1` — the per-trace report from `inspect --signal traces --summary`. */
export const TraceSummary = Schema.Struct({
  schema: Schema.Literal('otelite.trace-summary/v1'),
  trace_id: Schema.String,
  otlp_trace_id: Schema.NullOr(Schema.String),
  root_service: Schema.NullOr(Schema.String),
  span_count: Schema.Number,
  duration_ms: Schema.Number,
  timing_confidence: Schema.String,
  zero_duration_span_count: Schema.Number,
  zero_duration_work_span_count: Schema.Number,
  instant_event_span_count: Schema.Number,
  error_span_count: Schema.Number,
  grouped_duration_by_name: Schema.Array(DurationGroup),
  grouped_duration_by_service: Schema.Array(DurationGroup),
  slow_spans: Schema.Array(SlowSpan),
  error_spans: Schema.Array(ErrorSpan),
  top_labels: Schema.Array(Schema.Struct({ value: Schema.String, count: Schema.Number })),
  warnings: Schema.Array(Schema.String),
}).annotations({ identifier: 'Otelite.TraceSummary' })
export type TraceSummary = typeof TraceSummary.Type

/** `otelite.metric-summary/v1` — the aggregate report from `inspect --signal metrics --summary`. */
export const MetricSummary = Schema.Struct({
  schema: Schema.Literal('otelite.metric-summary/v1'),
  total_metrics: Schema.Number,
  total_data_points: Schema.Number,
  metrics: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      unit: Schema.String,
      services: Schema.Array(Schema.String),
      data_points: Schema.Number,
      // Present only for sum/gauge entries; absent for histogram/exphistogram.
      value_min: Schema.optional(Schema.Number),
      value_max: Schema.optional(Schema.Number),
      value_sum: Schema.optional(Schema.Number),
    }),
  ),
}).annotations({ identifier: 'Otelite.MetricSummary' })
export type MetricSummary = typeof MetricSummary.Type

/** `otelite.log-summary/v1` — the aggregate report from `inspect --signal logs --summary`. */
export const LogSummary = Schema.Struct({
  schema: Schema.Literal('otelite.log-summary/v1'),
  total: Schema.Number,
  by_service: Schema.Record({ key: Schema.String, value: Schema.Number }),
  by_severity: Schema.Record({ key: Schema.String, value: Schema.Number }),
}).annotations({ identifier: 'Otelite.LogSummary' })
export type LogSummary = typeof LogSummary.Type
