/**
 * CollectorClient service
 *
 * HTTP client for the OTEL Collector.
 * Provides health checking and span submission.
 */

import * as NodeFs from 'node:fs'
import * as NodePath from 'node:path'

import { HttpClient, HttpClientRequest } from '@effect/platform'
import { Data, Effect } from 'effect'

import { OtelConfig } from './OtelConfig.ts'

// =============================================================================
// Constants
// =============================================================================

/** HTTP status code threshold for errors. */
const HTTP_ERROR_STATUS_THRESHOLD = 400

/** Conversion factor from milliseconds to nanoseconds. */
const MILLISECONDS_TO_NANOSECONDS = 1_000_000n

/** Test span duration in nanoseconds (100ms). */
const TEST_SPAN_DURATION_NANOS = 100_000_000n

/** OpenTelemetry span kind: INTERNAL. */
const SPAN_KIND_INTERNAL = 1

/** OpenTelemetry status code: OK. */
const STATUS_CODE_OK = 1

// =============================================================================
// Errors
// =============================================================================

/** Error from OTEL Collector operations. */
export class CollectorError extends Data.TaggedError('CollectorError')<{
  readonly reason: 'Unreachable' | 'RequestFailed' | 'ParseError'
  readonly message: string
  readonly cause?: unknown
}> {}

// =============================================================================
// Client Functions
// =============================================================================

/**
 * Check if the OTEL Collector is healthy by querying its metrics endpoint.
 * Calls `GET /metrics` on the collector metrics port.
 */
export const checkHealth = (): Effect.Effect<
  boolean,
  CollectorError,
  OtelConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const config = yield* OtelConfig
    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.get(`${config.metricsUrl}/metrics`)
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new CollectorError({
            reason: 'Unreachable',
            message: `Failed to connect to Collector metrics at ${config.metricsUrl}`,
            cause: error,
          }),
      ),
    )

    return response.status < HTTP_ERROR_STATUS_THRESHOLD
  }).pipe(Effect.withSpan('CollectorClient.checkHealth'))

/**
 * Send a test OTLP span to the Collector.
 * Calls `POST /v1/traces` with a minimal OTLP payload.
 */
export const sendTestSpan = (options: {
  readonly serviceName: string
  readonly spanName: string
  readonly traceId: string
  readonly spanId: string
}): Effect.Effect<void, CollectorError, OtelConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const config = yield* OtelConfig
    const client = yield* HttpClient.HttpClient

    const nowNano = String(BigInt(Date.now()) * MILLISECONDS_TO_NANOSECONDS)
    const endNano = String(
      BigInt(Date.now()) * MILLISECONDS_TO_NANOSECONDS + TEST_SPAN_DURATION_NANOS,
    )

    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: 'service.name',
                value: { stringValue: options.serviceName },
              },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: options.traceId,
                  spanId: options.spanId,
                  name: options.spanName,
                  kind: SPAN_KIND_INTERNAL,
                  startTimeUnixNano: nowNano,
                  endTimeUnixNano: endNano,
                  status: { code: STATUS_CODE_OK },
                },
              ],
            },
          ],
        },
      ],
    }

    const request = yield* HttpClientRequest.bodyJson(body)(
      HttpClientRequest.post(`${config.collectorUrl}/v1/traces`).pipe(
        HttpClientRequest.setHeader('Content-Type', 'application/json'),
      ),
    ).pipe(
      Effect.mapError(
        (error) =>
          new CollectorError({
            reason: 'RequestFailed',
            message: 'Failed to build OTLP span request',
            cause: error,
          }),
      ),
    )

    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new CollectorError({
            reason: 'RequestFailed',
            message: `Failed to send test span to Collector at ${config.collectorUrl}`,
            cause: error,
          }),
      ),
    )

    if (response.status >= HTTP_ERROR_STATUS_THRESHOLD) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => '<no body>'))
      return yield* new CollectorError({
        reason: 'RequestFailed',
        message: `Collector rejected span with status ${String(response.status)}: ${text}`,
      })
    }
  }).pipe(
    Effect.withSpan('CollectorClient.sendTestSpan', {
      attributes: {
        serviceName: options.serviceName,
        spanName: options.spanName,
      },
    }),
  )

/**
 * Send a test OTLP span via the spool file path (otlpjsonfilereceiver).
 * Writes OTLP JSON as a single line to `$OTEL_SPAN_SPOOL_DIR/spans.jsonl`.
 */
export const sendTestSpanViaSpool = (options: {
  readonly serviceName: string
  readonly spanName: string
  readonly traceId: string
  readonly spanId: string
}): Effect.Effect<void, CollectorError> =>
  Effect.gen(function* () {
    const spoolDir = process.env['OTEL_SPAN_SPOOL_DIR']

    if (spoolDir === undefined || spoolDir.length === 0) {
      return yield* new CollectorError({
        reason: 'Unreachable',
        message: 'OTEL_SPAN_SPOOL_DIR not set — spool path not available',
      })
    }

    const nowNano = String(BigInt(Date.now()) * MILLISECONDS_TO_NANOSECONDS)
    const endNano = String(
      BigInt(Date.now()) * MILLISECONDS_TO_NANOSECONDS + TEST_SPAN_DURATION_NANOS,
    )

    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: 'service.name',
                value: { stringValue: options.serviceName },
              },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: options.traceId,
                  spanId: options.spanId,
                  name: options.spanName,
                  kind: SPAN_KIND_INTERNAL,
                  startTimeUnixNano: nowNano,
                  endTimeUnixNano: endNano,
                  status: { code: STATUS_CODE_OK },
                },
              ],
            },
          ],
        },
      ],
    }

    const filePath = NodePath.join(spoolDir, 'spans.jsonl')

    yield* Effect.try({
      try: () => {
        NodeFs.appendFileSync(filePath, JSON.stringify(body) + '\n')
      },
      catch: (error) =>
        new CollectorError({
          reason: 'RequestFailed',
          message: `Failed to write span to spool file at ${filePath}`,
          cause: error,
        }),
    })
  }).pipe(
    Effect.withSpan('CollectorClient.sendTestSpanViaSpool', {
      attributes: {
        serviceName: options.serviceName,
        spanName: options.spanName,
      },
    }),
  )
