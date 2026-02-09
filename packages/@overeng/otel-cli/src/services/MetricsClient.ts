/**
 * MetricsClient service
 *
 * HTTP client for querying metrics from the OTEL stack.
 * Supports two types of metrics:
 *
 * 1. TraceQL Metrics (from Tempo) - Application metrics derived from traces
 *    - Rate, histograms, quantiles computed from span data
 *    - Query via /api/metrics/query_range
 *
 * 2. Collector Metrics (from OTEL Collector) - Prometheus format internal stats
 *    - Exporter queue sizes, sent/failed spans, etc.
 *    - Query via /metrics endpoint
 */

import { HttpClient, HttpClientRequest } from '@effect/platform'
import { Data, Effect, Schema } from 'effect'

import { OtelConfig } from './OtelConfig.ts'

// =============================================================================
// Constants
// =============================================================================

/** Default time range for metrics queries (in seconds). */
const DEFAULT_TIME_RANGE_SECONDS = 3600 // 1 hour

/** Default step for metrics queries (in seconds). */
const DEFAULT_STEP_SECONDS = 60

/** HTTP status code threshold for errors. */
const HTTP_ERROR_STATUS_THRESHOLD = 400

/** String offsets for parsing Prometheus HELP and TYPE comments. */
const PROMETHEUS_HELP_PREFIX_LENGTH = 7 // "# HELP "
const PROMETHEUS_TYPE_PREFIX_LENGTH = 7 // "# TYPE "

// =============================================================================
// Errors
// =============================================================================

/** Error from metrics API operations. */
export class MetricsError extends Data.TaggedError('MetricsError')<{
  readonly reason: 'RequestFailed' | 'ParseError' | 'InvalidQuery'
  readonly message: string
  readonly cause?: unknown
}> {}

// =============================================================================
// Schemas — Tempo TraceQL Metrics API
// =============================================================================

/** A single label key-value pair on a metric series. */
export const MetricLabel = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({
    stringValue: Schema.optional(Schema.String),
  }),
})

/** A single sample (timestamp + value) in a time series. */
export const MetricSample = Schema.Struct({
  timestampMs: Schema.String,
  value: Schema.optional(Schema.Number),
})

/** An exemplar linking a metric sample to a trace. */
export const MetricExemplar = Schema.Struct({
  labels: Schema.Array(MetricLabel),
  value: Schema.Number,
  timestampMs: Schema.String,
})

/** A single metric series with labels and samples. */
export const MetricSeries = Schema.Struct({
  labels: Schema.Array(MetricLabel),
  samples: Schema.Array(MetricSample),
  exemplars: Schema.optional(Schema.Array(MetricExemplar)),
})

/** Response from Tempo /api/metrics/query_range. */
export const TraceQLMetricsResponse = Schema.Struct({
  series: Schema.Array(MetricSeries),
  metrics: Schema.optional(
    Schema.Struct({
      inspectedBytes: Schema.optional(Schema.String),
      inspectedSpans: Schema.optional(Schema.String),
      totalBlocks: Schema.optional(Schema.Number),
    }),
  ),
})

/** Type for decoded TraceQL metrics response. */
export type TraceQLMetricsResponse = typeof TraceQLMetricsResponse.Type

/** Type for a metric series. */
export type MetricSeries = typeof MetricSeries.Type

// =============================================================================
// Schemas — Tempo Tags API
// =============================================================================

/** Response from Tempo /api/search/tags. */
export const TagsResponse = Schema.Struct({
  tagNames: Schema.Array(Schema.String),
})

/** Response from Tempo /api/search/tag/:name/values. */
export const TagValuesResponse = Schema.Struct({
  tagValues: Schema.Array(Schema.String),
})

// =============================================================================
// Parsed Types
// =============================================================================

/** A parsed metric sample for display. */
export interface MetricDataPoint {
  readonly timestampMs: number
  readonly value: number
}

/** A parsed metric series for display. */
export interface ParsedMetricSeries {
  readonly name: string
  readonly labels: Record<string, string>
  readonly samples: ReadonlyArray<MetricDataPoint>
  readonly exemplarCount: number
}

/** Summary of available span attributes (for metrics grouping). */
export interface SpanAttribute {
  readonly name: string
  readonly values: ReadonlyArray<string>
}

// =============================================================================
// Collector Metrics Parsing (Prometheus format)
// =============================================================================

/** A single Prometheus metric with name, labels, and value. */
export interface PrometheusMetric {
  readonly name: string
  readonly labels: Record<string, string>
  readonly value: number
  readonly type: 'counter' | 'gauge' | 'histogram' | 'summary' | 'unknown'
  readonly help?: string
}

/** Parsed collector metrics grouped by name. */
export interface CollectorMetrics {
  readonly metrics: ReadonlyArray<PrometheusMetric>
  readonly metricNames: ReadonlyArray<string>
}

// =============================================================================
// Client Functions — TraceQL Metrics
// =============================================================================

/**
 * Query TraceQL metrics from Tempo.
 *
 * @param query - TraceQL metrics query (e.g., `{} | rate()`, `{service.name="dt"} | histogram_over_time(duration)`)
 * @param options - Time range and step configuration
 */
export const queryMetrics = (options: {
  readonly query: string
  readonly start?: number // Unix timestamp in seconds (default: 1 hour ago)
  readonly end?: number // Unix timestamp in seconds (default: now)
  readonly step?: number // Step in seconds (default: 60)
}): Effect.Effect<
  ReadonlyArray<ParsedMetricSeries>,
  MetricsError,
  OtelConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const config = yield* OtelConfig
    const client = yield* HttpClient.HttpClient

    const now = Math.floor(Date.now() / 1000)
    const start = options.start ?? now - DEFAULT_TIME_RANGE_SECONDS
    const end = options.end ?? now
    const step = options.step ?? DEFAULT_STEP_SECONDS
    const query = options.query

    const params = new URLSearchParams({
      q: query,
      start: String(start),
      end: String(end),
      step: String(step),
    })

    const request = HttpClientRequest.get(
      `${config.tempoQueryUrl}/api/metrics/query_range?${params.toString()}`,
    )

    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new MetricsError({
            reason: 'RequestFailed',
            message: `Failed to query Tempo metrics`,
            cause: error,
          }),
      ),
    )

    if (response.status >= HTTP_ERROR_STATUS_THRESHOLD) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => '<no body>'))
      // Check for TraceQL parse errors
      if (text.includes('parse error') || text.includes('syntax error')) {
        return yield* new MetricsError({
          reason: 'InvalidQuery',
          message: text,
        })
      }
      return yield* new MetricsError({
        reason: 'RequestFailed',
        message: `Tempo metrics query failed with status ${String(response.status)}: ${text}`,
      })
    }

    const json = yield* response.json.pipe(
      Effect.mapError(
        (error) =>
          new MetricsError({
            reason: 'ParseError',
            message: 'Failed to parse Tempo metrics response',
            cause: error,
          }),
      ),
    )

    const decoded = yield* Schema.decodeUnknown(TraceQLMetricsResponse)(json).pipe(
      Effect.mapError(
        (error) =>
          new MetricsError({
            reason: 'ParseError',
            message: 'Failed to decode Tempo metrics response',
            cause: error,
          }),
      ),
    )

    return parseMetricsSeries(decoded)
  }).pipe(Effect.withSpan('MetricsClient.queryMetrics', { attributes: { query: options.query } }))

/**
 * Get available span attribute names (tags) from Tempo.
 * These can be used to group/filter TraceQL metrics queries.
 */
export const getTags = (): Effect.Effect<
  ReadonlyArray<string>,
  MetricsError,
  OtelConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const config = yield* OtelConfig
    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.get(`${config.tempoQueryUrl}/api/search/tags`)
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new MetricsError({
            reason: 'RequestFailed',
            message: 'Failed to get Tempo tags',
            cause: error,
          }),
      ),
    )

    const json = yield* response.json.pipe(
      Effect.mapError(
        (error) =>
          new MetricsError({
            reason: 'ParseError',
            message: 'Failed to parse Tempo tags response',
            cause: error,
          }),
      ),
    )

    const decoded = yield* Schema.decodeUnknown(TagsResponse)(json).pipe(
      Effect.mapError(
        (error) =>
          new MetricsError({
            reason: 'ParseError',
            message: 'Failed to decode Tempo tags response',
            cause: error,
          }),
      ),
    )

    return decoded.tagNames
  }).pipe(Effect.withSpan('MetricsClient.getTags'))

/**
 * Get values for a specific span attribute (tag) from Tempo.
 */
export const getTagValues = (
  tagName: string,
): Effect.Effect<ReadonlyArray<string>, MetricsError, OtelConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const config = yield* OtelConfig
    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.get(
      `${config.tempoQueryUrl}/api/search/tag/${encodeURIComponent(tagName)}/values`,
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new MetricsError({
            reason: 'RequestFailed',
            message: `Failed to get values for tag ${tagName}`,
            cause: error,
          }),
      ),
    )

    const json = yield* response.json.pipe(
      Effect.mapError(
        (error) =>
          new MetricsError({
            reason: 'ParseError',
            message: `Failed to parse tag values response for ${tagName}`,
            cause: error,
          }),
      ),
    )

    const decoded = yield* Schema.decodeUnknown(TagValuesResponse)(json).pipe(
      Effect.mapError(
        (error) =>
          new MetricsError({
            reason: 'ParseError',
            message: `Failed to decode tag values response for ${tagName}`,
            cause: error,
          }),
      ),
    )

    return decoded.tagValues
  }).pipe(Effect.withSpan('MetricsClient.getTagValues', { attributes: { tagName } }))

// =============================================================================
// Client Functions — Collector Metrics
// =============================================================================

/**
 * Get OTEL Collector internal metrics (Prometheus format).
 * Returns metrics about the collector's health: queue sizes, sent/failed spans, etc.
 */
export const getCollectorMetrics = (): Effect.Effect<
  CollectorMetrics,
  MetricsError,
  OtelConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const config = yield* OtelConfig
    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.get(`${config.metricsUrl}/metrics`)
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new MetricsError({
            reason: 'RequestFailed',
            message: `Failed to get collector metrics from ${config.metricsUrl}`,
            cause: error,
          }),
      ),
    )

    const text = yield* response.text.pipe(
      Effect.mapError(
        (error) =>
          new MetricsError({
            reason: 'ParseError',
            message: 'Failed to read collector metrics response',
            cause: error,
          }),
      ),
    )

    return parsePrometheusMetrics(text)
  }).pipe(Effect.withSpan('MetricsClient.getCollectorMetrics'))

// =============================================================================
// Internal Helpers
// =============================================================================

/** Parse TraceQL metrics response into structured series. */
export const parseMetricsSeries = (
  response: TraceQLMetricsResponse,
): ReadonlyArray<ParsedMetricSeries> =>
  response.series.map((series) => {
    const labels: Record<string, string> = {}
    let name = 'metric'

    for (const label of series.labels) {
      const value = label.value.stringValue ?? ''
      if (label.key === '__name__') {
        name = value
      } else {
        labels[label.key] = value
      }
    }

    const samples: MetricDataPoint[] = series.samples
      .filter((s) => s.value !== undefined)
      .map((s) => ({
        timestampMs: parseInt(s.timestampMs, 10),
        value: s.value!,
      }))

    return {
      name,
      labels,
      samples,
      exemplarCount: series.exemplars?.length ?? 0,
    }
  })

/** Parse Prometheus text format into structured metrics. */
export const parsePrometheusMetrics = (text: string): CollectorMetrics => {
  const lines = text.split('\n')
  const metrics: PrometheusMetric[] = []
  const metricNamesSet = new Set<string>()

  let currentHelp: string | undefined
  let currentType: PrometheusMetric['type'] = 'unknown'

  for (const line of lines) {
    const trimmed = line.trim()

    // Skip empty lines
    if (trimmed === '') continue

    // Parse HELP comments
    if (trimmed.startsWith('# HELP ')) {
      const rest = trimmed.slice(PROMETHEUS_HELP_PREFIX_LENGTH)
      const spaceIdx = rest.indexOf(' ')
      currentHelp = spaceIdx > 0 ? rest.slice(spaceIdx + 1) : undefined
      continue
    }

    // Parse TYPE comments
    if (trimmed.startsWith('# TYPE ')) {
      const rest = trimmed.slice(PROMETHEUS_TYPE_PREFIX_LENGTH)
      const parts = rest.split(' ')
      const typeStr = parts[1] ?? 'unknown'
      currentType =
        typeStr === 'counter' ||
        typeStr === 'gauge' ||
        typeStr === 'histogram' ||
        typeStr === 'summary'
          ? typeStr
          : 'unknown'
      continue
    }

    // Skip other comments
    if (trimmed.startsWith('#')) continue

    // Parse metric line: name{labels} value
    const match = trimmed.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{?([^}]*)\}?\s+(-?[\d.e+-]+|NaN|Inf|-Inf)$/,
    )
    if (match) {
      const name = match[1]!
      const labelsStr = match[2] ?? ''
      const valueStr = match[3]!

      const labels: Record<string, string> = {}
      if (labelsStr) {
        // Parse labels: key="value",key2="value2"
        const labelMatches = labelsStr.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g)
        for (const lm of labelMatches) {
          labels[lm[1]!] = lm[2]!
        }
      }

      const value = parseFloat(valueStr)
      if (!isNaN(value)) {
        const metric: PrometheusMetric = {
          name,
          labels,
          value,
          type: currentType,
        }
        if (currentHelp !== undefined) {
          ;(metric as { help: string }).help = currentHelp
        }
        metrics.push(metric)
        metricNamesSet.add(name)
      }
    }

    // Reset for next metric family
    if (trimmed.startsWith('# HELP')) {
      currentHelp = undefined
      currentType = 'unknown'
    }
  }

  return {
    metrics,
    metricNames: Array.from(metricNamesSet).toSorted(),
  }
}
