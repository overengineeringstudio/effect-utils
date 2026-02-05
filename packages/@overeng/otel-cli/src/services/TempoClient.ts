/**
 * TempoClient service
 *
 * HTTP client for the Tempo distributed tracing backend.
 * Provides trace lookup and health checking via the Tempo HTTP API.
 */

import { HttpClient, HttpClientRequest } from '@effect/platform'
import { Data, Effect, Schema } from 'effect'

import { OtelConfig } from './OtelConfig.ts'

// =============================================================================
// Errors
// =============================================================================

/** Error from Tempo API operations. */
export class TempoError extends Data.TaggedError('TempoError')<{
  readonly reason: 'NotReady' | 'NotFound' | 'RequestFailed' | 'ParseError'
  readonly message: string
  readonly cause?: unknown
}> {}

// =============================================================================
// Schemas — Tempo /api/traces/:id response
// =============================================================================

/** A single key-value attribute on a span. */
export const SpanAttribute = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({
    stringValue: Schema.optional(Schema.String),
    intValue: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
    boolValue: Schema.optional(Schema.Boolean),
  }),
})

/** Schema for a span's status. */
export const SpanStatus = Schema.Struct({
  code: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
})

/** Schema for a single span within a trace. */
export const TempoSpan = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  operationName: Schema.String,
  startTimeUnixNano: Schema.Union(Schema.String, Schema.Number),
  endTimeUnixNano: Schema.Union(Schema.String, Schema.Number),
  status: Schema.optional(SpanStatus),
  attributes: Schema.optional(Schema.Array(SpanAttribute)),
})

/** A resource describes the entity producing telemetry (e.g. service.name). */
export const TempoResource = Schema.Struct({
  attributes: Schema.optional(Schema.Array(SpanAttribute)),
})

/** A scope span is a group of spans within a single instrumentation scope. */
export const TempoScopeSpan = Schema.Struct({
  spans: Schema.Array(TempoSpan),
})

/** A resource span groups scope spans under a resource. */
export const TempoResourceSpan = Schema.Struct({
  resource: Schema.optional(TempoResource),
  scopeSpans: Schema.Array(TempoScopeSpan),
})

/** Schema for the full Tempo /api/traces/:id response. */
export const TempoTraceResponse = Schema.Struct({
  batches: Schema.optional(Schema.Array(TempoResourceSpan)),
  resourceSpans: Schema.optional(Schema.Array(TempoResourceSpan)),
})

/** Type for the decoded trace response. */
export type TempoTraceResponse = typeof TempoTraceResponse.Type

// =============================================================================
// Client Functions
// =============================================================================

/**
 * Check if Tempo is ready.
 * Calls `GET /ready` and expects plain text "ready".
 */
export const checkReady = (): Effect.Effect<
  boolean,
  TempoError,
  OtelConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const config = yield* OtelConfig
    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.get(`${config.tempoQueryUrl}/ready`)
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new TempoError({
            reason: 'RequestFailed',
            message: `Failed to connect to Tempo at ${config.tempoQueryUrl}`,
            cause: error,
          }),
      ),
    )

    if (response.status >= 400) {
      return false
    }

    const text = yield* response.text.pipe(
      Effect.mapError(
        (error) =>
          new TempoError({
            reason: 'ParseError',
            message: 'Failed to read Tempo ready response',
            cause: error,
          }),
      ),
    )

    return text.trim() === 'ready'
  }).pipe(Effect.withSpan('TempoClient.checkReady'))

/**
 * Get a trace by its ID.
 * Calls `GET /api/traces/:traceId` and decodes the OTLP trace response.
 */
export const getTrace = (
  traceId: string,
): Effect.Effect<TempoTraceResponse, TempoError, OtelConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const config = yield* OtelConfig
    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.get(`${config.tempoQueryUrl}/api/traces/${traceId}`)
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new TempoError({
            reason: 'RequestFailed',
            message: `Failed to fetch trace ${traceId} from Tempo`,
            cause: error,
          }),
      ),
    )

    if (response.status === 404) {
      return yield* new TempoError({
        reason: 'NotFound',
        message: `Trace ${traceId} not found in Tempo`,
      })
    }

    if (response.status >= 400) {
      return yield* new TempoError({
        reason: 'RequestFailed',
        message: `Tempo returned status ${String(response.status)} for trace ${traceId}`,
      })
    }

    const json = yield* response.json.pipe(
      Effect.mapError(
        (error) =>
          new TempoError({
            reason: 'ParseError',
            message: `Failed to parse JSON response for trace ${traceId}`,
            cause: error,
          }),
      ),
    )

    return yield* Schema.decodeUnknown(TempoTraceResponse)(json).pipe(
      Effect.mapError(
        (error) =>
          new TempoError({
            reason: 'ParseError',
            message: `Failed to decode trace response for ${traceId}`,
            cause: error,
          }),
      ),
    )
  }).pipe(Effect.withSpan('TempoClient.getTrace', { attributes: { traceId } }))
