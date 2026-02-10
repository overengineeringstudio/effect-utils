/**
 * GrafanaClient service
 *
 * HTTP client for the Grafana API. Provides health checks, dashboard listing,
 * datasource discovery, and TraceQL search via the Grafana datasource proxy.
 */

import { HttpClient, HttpClientRequest } from '@effect/platform'
import { Data, DateTime, Effect, Schema } from 'effect'

import { OtelConfig } from './OtelConfig.ts'

// =============================================================================
// Constants
// =============================================================================

/** Default limit for trace search results. */
const DEFAULT_TRACE_SEARCH_LIMIT = 10

/** Tempo's internal service name, excluded from trace search by default. */
const TEMPO_INTERNAL_SERVICE = 'tempo-all'

/** HTTP status code threshold for errors. */
const HTTP_ERROR_STATUS_THRESHOLD = 400

/** Nanoseconds per millisecond for Tempo timestamp conversion. */
const NANOS_PER_MS = 1_000_000

// =============================================================================
// Errors
// =============================================================================

/** Error from Grafana API operations. */
export class GrafanaError extends Data.TaggedError('GrafanaError')<{
  readonly reason: 'Unreachable' | 'RequestFailed' | 'ParseError' | 'DatasourceNotFound'
  readonly message: string
  readonly cause?: unknown
}> {}

// =============================================================================
// Schemas
// =============================================================================

/** Grafana /api/health response. */
export const GrafanaHealthResponse = Schema.Struct({
  version: Schema.String,
  database: Schema.String,
})

/** Type for the decoded Grafana health response. */
export type GrafanaHealthResponse = typeof GrafanaHealthResponse.Type

/** A single Grafana datasource. */
export const GrafanaDatasource = Schema.Struct({
  uid: Schema.String,
  name: Schema.String,
  type: Schema.String,
  url: Schema.String,
  isDefault: Schema.optional(Schema.Boolean),
})

/** Type for a decoded Grafana datasource. */
export type GrafanaDatasource = typeof GrafanaDatasource.Type

/** A single Grafana dashboard from search results. */
export const GrafanaDashboard = Schema.Struct({
  uid: Schema.String,
  title: Schema.String,
  url: Schema.String,
})

/** Type for a decoded Grafana dashboard. */
export type GrafanaDashboard = typeof GrafanaDashboard.Type

/** A key-value attribute in Tempo's OTLP-style span representation. */
const TempoAttribute = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({
    stringValue: Schema.String,
  }),
})

/**
 * A span matched by a TraceQL query, returned inside `spanSets`.
 * Only present when the query includes a pipeline stage like `| select(name)`.
 */
const TempoMatchedSpan = Schema.Struct({
  spanID: Schema.String,
  /** Span operation name. Projected by `| select(name)` in the TraceQL query. */
  name: Schema.optionalWith(Schema.String, { default: () => '' }),
  startTimeUnixNano: Schema.String,
  /** Duration as a string of nanoseconds (e.g. "5957502611"). */
  durationNanos: Schema.String,
  /** Resource/span attributes matching the query filter (e.g. `service.name`). */
  attributes: Schema.optionalWith(Schema.Array(TempoAttribute), { default: () => [] }),
})

/** A set of spans matching a TraceQL query within a single trace. */
const TempoSpanSet = Schema.Struct({
  spans: Schema.Array(TempoMatchedSpan),
  /** Total number of spans matching the query in this trace. */
  matched: Schema.Number,
})

/**
 * A trace from Tempo's native search API (`/api/search`).
 *
 * Root-level fields (`rootServiceName`, `rootTraceName`) describe the trace's
 * root span. When the query includes `| select(name)`, `spanSets` contains
 * the actual matched spans with span-level details — these may differ from the
 * root span (e.g. `dt/ts:check` is a child of `devenv/shell:entry`).
 */
const TempoSearchTrace = Schema.Struct({
  traceID: Schema.String,
  /** Service name of the root span. Literal `<root span not yet received>` when unavailable. */
  rootServiceName: Schema.String,
  /** Operation name of the root span. Missing when root span hasn't been received yet. */
  rootTraceName: Schema.optionalWith(Schema.String, { default: () => '' }),
  /** Trace-level duration in milliseconds (covers the entire trace, not individual spans). */
  durationMs: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  startTimeUnixNano: Schema.String,
  /** Matched span sets from TraceQL pipeline stages (e.g. `| select(name)`). */
  spanSets: Schema.optionalWith(Schema.Array(TempoSpanSet), { default: () => [] }),
})

/** Response from Tempo's native search API. */
const TempoSearchResponse = Schema.Struct({
  traces: Schema.optionalWith(Schema.Array(TempoSearchTrace), { default: () => [] }),
})

/** Response from Tempo's tag values API (`/api/search/tag/{tag}/values`). */
const TempoTagValuesResponse = Schema.Struct({
  tagValues: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
})

// =============================================================================
// Trace search result (parsed from data frames)
// =============================================================================

/** A single trace summary from a TraceQL search. */
export interface TraceSearchResult {
  readonly traceId: string
  readonly serviceName: string
  readonly spanName: string
  readonly durationMs: number
  readonly startTime: DateTime.Utc
}

// =============================================================================
// Client Functions
// =============================================================================

/**
 * Check Grafana health.
 * Calls `GET /api/health` and returns version + database status.
 */
export const checkHealth = (): Effect.Effect<
  GrafanaHealthResponse,
  GrafanaError,
  OtelConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const config = yield* OtelConfig
    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.get(`${config.grafanaUrl}/api/health`)
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'Unreachable',
            message: `Failed to connect to Grafana at ${config.grafanaUrl}`,
            cause: error,
          }),
      ),
    )

    const json = yield* response.json.pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'ParseError',
            message: 'Failed to parse Grafana health response',
            cause: error,
          }),
      ),
    )

    return yield* Schema.decodeUnknown(GrafanaHealthResponse)(json).pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'ParseError',
            message: 'Failed to decode Grafana health response',
            cause: error,
          }),
      ),
    )
  }).pipe(Effect.withSpan('GrafanaClient.checkHealth'))

/**
 * List all datasources.
 * Calls `GET /api/datasources`.
 */
export const listDatasources = (): Effect.Effect<
  ReadonlyArray<GrafanaDatasource>,
  GrafanaError,
  OtelConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const config = yield* OtelConfig
    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.get(`${config.grafanaUrl}/api/datasources`)
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'RequestFailed',
            message: 'Failed to list Grafana datasources',
            cause: error,
          }),
      ),
    )

    const json = yield* response.json.pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'ParseError',
            message: 'Failed to parse datasources response',
            cause: error,
          }),
      ),
    )

    return yield* Schema.decodeUnknown(Schema.Array(GrafanaDatasource))(json).pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'ParseError',
            message: 'Failed to decode datasources response',
            cause: error,
          }),
      ),
    )
  }).pipe(Effect.withSpan('GrafanaClient.listDatasources'))

/**
 * Get the Tempo datasource UID.
 * Finds the first datasource with type "tempo".
 */
export const getTempoUid = (): Effect.Effect<
  string,
  GrafanaError,
  OtelConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const datasources = yield* listDatasources()
    const tempo = datasources.find((ds) => ds.type === 'tempo')

    if (tempo === undefined) {
      return yield* new GrafanaError({
        reason: 'DatasourceNotFound',
        message: 'No Tempo datasource found in Grafana',
      })
    }

    return tempo.uid
  }).pipe(Effect.withSpan('GrafanaClient.getTempoUid'))

/**
 * List dashboards.
 * Calls `GET /api/search?type=dash-db`.
 */
export const listDashboards = (): Effect.Effect<
  ReadonlyArray<GrafanaDashboard>,
  GrafanaError,
  OtelConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const config = yield* OtelConfig
    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.get(`${config.grafanaUrl}/api/search?type=dash-db`)
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'RequestFailed',
            message: 'Failed to list Grafana dashboards',
            cause: error,
          }),
      ),
    )

    const json = yield* response.json.pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'ParseError',
            message: 'Failed to parse dashboards response',
            cause: error,
          }),
      ),
    )

    return yield* Schema.decodeUnknown(Schema.Array(GrafanaDashboard))(json).pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'ParseError',
            message: 'Failed to decode dashboards response',
            cause: error,
          }),
      ),
    )
  }).pipe(Effect.withSpan('GrafanaClient.listDashboards'))

/**
 * Get service names from Tempo's tag values API.
 * Calls `GET /api/datasources/proxy/uid/{tempo}/api/search/tag/service.name/values`.
 */
const getServiceNames: Effect.Effect<
  ReadonlyArray<string>,
  GrafanaError,
  OtelConfig | HttpClient.HttpClient
> = Effect.gen(function* () {
  const config = yield* OtelConfig
  const client = yield* HttpClient.HttpClient
  const tempoUid = yield* getTempoUid()

  const url = `${config.grafanaUrl}/api/datasources/proxy/uid/${tempoUid}/api/search/tag/service.name/values`

  const request = HttpClientRequest.get(url)
  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (error) =>
        new GrafanaError({
          reason: 'RequestFailed',
          message: 'Failed to fetch service names from Tempo',
          cause: error,
        }),
    ),
  )

  const json = yield* response.json.pipe(
    Effect.mapError(
      (error) =>
        new GrafanaError({
          reason: 'ParseError',
          message: 'Failed to parse tag values response',
          cause: error,
        }),
    ),
  )

  const decoded = yield* Schema.decodeUnknown(TempoTagValuesResponse)(json).pipe(
    Effect.mapError(
      (error) =>
        new GrafanaError({
          reason: 'ParseError',
          message: 'Failed to decode tag values response',
          cause: error,
        }),
    ),
  )

  return decoded.tagValues
}).pipe(Effect.withSpan('GrafanaClient.getServiceNames'))

/**
 * Search traces via Tempo's native search API through the Grafana datasource proxy.
 *
 * Uses `GET /api/datasources/proxy/uid/{tempo}/api/search` with a positive
 * regex filter on `resource.service.name` to exclude internal Tempo traces.
 *
 * TraceQL negation filters (`!=`) are unreliable: spans missing the attribute
 * are excluded (grafana/tempo#2618) and search results are intentionally
 * non-deterministic (grafana/tempo#1988). Grafana's ds/query endpoint also
 * doesn't support TraceQL properly (grafana/grafana#95042).
 *
 * Instead, we query Tempo's native search API directly, discover available
 * service names via the tag values API, and build a positive regex filter.
 */
export const searchTraces = (options: {
  readonly query?: string | undefined
  readonly limit?: number | undefined
  readonly includeInternal?: boolean | undefined
}): Effect.Effect<
  ReadonlyArray<TraceSearchResult>,
  GrafanaError,
  OtelConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const config = yield* OtelConfig
    const client = yield* HttpClient.HttpClient
    const tempoUid = yield* getTempoUid()

    const limit = options.limit ?? DEFAULT_TRACE_SEARCH_LIMIT
    const query = yield* buildTraceQuery(options)

    const params = new URLSearchParams({ q: query, limit: String(limit), spss: '1' })
    const url = `${config.grafanaUrl}/api/datasources/proxy/uid/${tempoUid}/api/search?${params.toString()}`

    const request = HttpClientRequest.get(url)
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'RequestFailed',
            message: 'Failed to execute trace search',
            cause: error,
          }),
      ),
    )

    if (response.status >= HTTP_ERROR_STATUS_THRESHOLD) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => '<no body>'))
      return yield* new GrafanaError({
        reason: 'RequestFailed',
        message: `Tempo search failed with status ${String(response.status)}: ${text}`,
      })
    }

    const json = yield* response.json.pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'ParseError',
            message: 'Failed to parse trace search response',
            cause: error,
          }),
      ),
    )

    const decoded = yield* Schema.decodeUnknown(TempoSearchResponse)(json).pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'ParseError',
            message: 'Failed to decode trace search response',
            cause: error,
          }),
      ),
    )

    return parseTempoTraces(decoded.traces)
  }).pipe(Effect.withSpan('GrafanaClient.searchTraces'))

// =============================================================================
// Grafana URL Builder
// =============================================================================

const TEMPO_DATASOURCE = { type: 'tempo', uid: 'tempo' } as const

/** Build a Grafana Explore URL that opens a specific trace by ID. */
export const buildGrafanaTraceUrl = ({
  grafanaUrl,
  traceId,
}: {
  readonly grafanaUrl: string
  readonly traceId: string
}): string => {
  const panes = {
    a: {
      datasource: TEMPO_DATASOURCE,
      queries: [
        {
          refId: 'A',
          datasource: TEMPO_DATASOURCE,
          queryType: 'traceql',
          query: traceId,
        },
      ],
      range: { from: 'now-1h', to: 'now' },
    },
  }
  const tsHostname = process.env['TS_HOSTNAME']
  const publicUrl =
    tsHostname !== undefined && tsHostname.length > 0
      ? grafanaUrl.replace('127.0.0.1', tsHostname)
      : grafanaUrl
  return `${publicUrl}/explore?schemaVersion=1&panes=${encodeURIComponent(Schema.encodeSync(Schema.parseJson(Schema.Unknown))(panes))}&orgId=1`
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Build a TraceQL query that excludes internal Tempo traces unless requested.
 *
 * Uses a positive regex filter (`=~`) on `resource.service.name` built from
 * discovered service names, because TraceQL negation filters (`!=`) are
 * unreliable (see grafana/tempo#2618, grafana/tempo#1988).
 *
 * Appends `| select(name)` to project the matched span's operation name into
 * the response `spanSets`, enabling display of child span names (e.g.
 * `dt/ts:check`) instead of only root span info (`devenv/shell:entry`).
 */
const buildTraceQuery = (options: {
  readonly query?: string | undefined
  readonly includeInternal?: boolean | undefined
}): Effect.Effect<string, GrafanaError, OtelConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const baseQuery = options.query ?? '{}'
    if (options.includeInternal === true) return `${baseQuery} | select(name)`
    // Only inject the service filter when the user hasn't provided a custom query
    // (custom queries may already filter by service name).
    if (baseQuery !== '{}') return `${baseQuery} | select(name)`

    const serviceNames = yield* getServiceNames
    const userServices = serviceNames.filter((s) => s !== TEMPO_INTERNAL_SERVICE)

    // Fall back to unfiltered query if no user services are found
    if (userServices.length === 0) return '{} | select(name)'

    return `{resource.service.name=~"${userServices.join('|')}"} | select(name)`
  })

/**
 * Convert Tempo search API traces to our domain type.
 *
 * Prefers matched span data from `spanSets` (populated by `| select(name)`)
 * over root span data. This surfaces child spans like `dt/ts:check` that would
 * otherwise be hidden behind the root span `devenv/shell:entry`.
 */
export const parseTempoTraces = (
  traces: ReadonlyArray<typeof TempoSearchTrace.Type>,
): ReadonlyArray<TraceSearchResult> => {
  const results = traces.map((t) => {
    const matched = t.spanSets[0]?.spans[0]
    if (matched !== undefined) {
      const serviceName =
        matched.attributes.find((a) => a.key === 'service.name')?.value.stringValue ??
        t.rootServiceName
      return {
        traceId: t.traceID,
        serviceName,
        spanName: matched.name,
        durationMs: Number(BigInt(matched.durationNanos) / BigInt(NANOS_PER_MS)),
        startTime: DateTime.unsafeMake(
          Number(BigInt(matched.startTimeUnixNano) / BigInt(NANOS_PER_MS)),
        ),
      }
    }
    // Fallback to root span info when spanSets are absent
    return {
      traceId: t.traceID,
      serviceName: t.rootServiceName,
      spanName: t.rootTraceName,
      durationMs: t.durationMs,
      startTime: DateTime.unsafeMake(Number(BigInt(t.startTimeUnixNano) / BigInt(NANOS_PER_MS))),
    }
  })

  // Tempo returns traces sorted by most recent first, but we sort explicitly
  // to guarantee the contract.
  return results.toSorted(
    (a, b) => DateTime.toEpochMillis(b.startTime) - DateTime.toEpochMillis(a.startTime),
  )
}
