/**
 * CollectorClient service
 *
 * HTTP client for the OTEL Collector.
 * Provides health checking and span submission.
 */

import { HttpClient, HttpClientRequest } from '@effect/platform'
import { Data, Effect } from 'effect'

import { OtelConfig } from './OtelConfig.ts'

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

    return response.status < 400
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

    const nowNano = String(BigInt(Date.now()) * 1_000_000n)
    const endNano = String(BigInt(Date.now()) * 1_000_000n + 100_000_000n) // +100ms

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
                  kind: 1,
                  startTimeUnixNano: nowNano,
                  endTimeUnixNano: endNano,
                  status: { code: 1 },
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

    if (response.status >= 400) {
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
