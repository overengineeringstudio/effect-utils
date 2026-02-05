/**
 * GrafanaClient service
 *
 * HTTP client for the Grafana API. Provides health checks, dashboard listing,
 * datasource discovery, and TraceQL search via the Grafana datasource proxy.
 */

import { HttpClient, HttpClientRequest } from '@effect/platform'
import { Data, Effect, Schema } from 'effect'

import { OtelConfig } from './OtelConfig.ts'

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

/** Schema field descriptor from a Grafana data frame. */
export const GrafanaFrameField = Schema.Struct({
  name: Schema.String,
})

/** Schema for a Grafana data frame. */
export const GrafanaDataFrame = Schema.Struct({
  schema: Schema.Struct({
    fields: Schema.Array(GrafanaFrameField),
  }),
  data: Schema.Struct({
    values: Schema.Array(Schema.Array(Schema.Unknown)),
  }),
})

/** Schema for TraceQL search results via /api/ds/query. */
export const GrafanaQueryResponse = Schema.Struct({
  results: Schema.Struct({
    A: Schema.Struct({
      frames: Schema.optional(Schema.Array(GrafanaDataFrame)),
    }),
  }),
})

/** Type for the decoded Grafana query response. */
export type GrafanaQueryResponse = typeof GrafanaQueryResponse.Type

// =============================================================================
// Trace search result (parsed from data frames)
// =============================================================================

/** A single trace summary from a TraceQL search. */
export interface TraceSearchResult {
  readonly traceId: string
  readonly serviceName: string
  readonly spanName: string
  readonly durationMs: number
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
 * Search traces using TraceQL via Grafana datasource proxy.
 * Calls `POST /api/ds/query` with a TraceQL query.
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

    const limit = options.limit ?? 10
    const baseQuery = options.query ?? '{}'
    const query =
      options.includeInternal === true
        ? baseQuery
        : baseQuery === '{}'
          ? '{resource.service.name!="tempo-all"}'
          : baseQuery

    const body = {
      queries: [
        {
          refId: 'A',
          datasource: { uid: tempoUid, type: 'tempo' },
          queryType: 'traceql',
          query,
          limit,
          tableType: 'traces',
        },
      ],
      from: 'now-1h',
      to: 'now',
    }

    const request = yield* HttpClientRequest.bodyJson(body)(
      HttpClientRequest.post(`${config.grafanaUrl}/api/ds/query`).pipe(
        HttpClientRequest.setHeader('Content-Type', 'application/json'),
      ),
    ).pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'RequestFailed',
            message: 'Failed to build TraceQL query request',
            cause: error,
          }),
      ),
    )

    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'RequestFailed',
            message: 'Failed to execute TraceQL search',
            cause: error,
          }),
      ),
    )

    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => '<no body>'))
      return yield* new GrafanaError({
        reason: 'RequestFailed',
        message: `Grafana TraceQL query failed with status ${String(response.status)}: ${text}`,
      })
    }

    const json = yield* response.json.pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'ParseError',
            message: 'Failed to parse TraceQL search response',
            cause: error,
          }),
      ),
    )

    const decoded = yield* Schema.decodeUnknown(GrafanaQueryResponse)(json).pipe(
      Effect.mapError(
        (error) =>
          new GrafanaError({
            reason: 'ParseError',
            message: 'Failed to decode TraceQL search response',
            cause: error,
          }),
      ),
    )

    return parseDataFrames(decoded)
  }).pipe(Effect.withSpan('GrafanaClient.searchTraces'))

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Parse Grafana data frames into trace search results.
 * Data frames use columnar format: schema.fields describes columns, data.values holds arrays.
 */
const parseDataFrames = (response: GrafanaQueryResponse): ReadonlyArray<TraceSearchResult> => {
  const frames = response.results.A.frames ?? []
  const results: Array<TraceSearchResult> = []

  for (const frame of frames) {
    const { fields } = frame.schema
    const { values } = frame.data

    // Build field index map
    const fieldIndex: Record<string, number> = {}
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]
      if (field !== undefined) {
        fieldIndex[field.name] = i
      }
    }

    const traceIdCol = fieldIndex['traceID']
    const serviceCol = fieldIndex['traceService']
    const nameCol = fieldIndex['traceName']
    const durationCol = fieldIndex['traceDuration']

    if (
      traceIdCol === undefined ||
      serviceCol === undefined ||
      nameCol === undefined ||
      durationCol === undefined
    ) {
      continue
    }

    const traceIds = values[traceIdCol] ?? []
    const rowCount = traceIds.length

    for (let i = 0; i < rowCount; i++) {
      results.push({
        traceId: String(values[traceIdCol]?.[i] ?? ''),
        serviceName: String(values[serviceCol]?.[i] ?? ''),
        spanName: String(values[nameCol]?.[i] ?? ''),
        durationMs: Number(values[durationCol]?.[i] ?? 0),
      })
    }
  }

  return results
}
