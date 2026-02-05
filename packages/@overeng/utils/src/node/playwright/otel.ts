/**
 * OTEL integration for Playwright tests.
 *
 * Provides:
 * - Parent span propagation across process boundaries
 * - OTEL exporter layer for Playwright test traces
 *
 * NOTE: This module uses the root @effect/opentelemetry import which requires
 * @opentelemetry/sdk-* peer dependencies. This is needed for `currentOtelSpan`
 * which accesses the underlying OTEL span for cross-process context propagation.
 *
 * @module
 */

import { OtlpSerialization, OtlpTracer, Tracer } from '@effect/opentelemetry'
import { FetchHttpClient } from '@effect/platform'
import { Effect, Layer, Schema } from 'effect'

/**
 * Minimal parent span context needed to join an existing trace across process boundaries.
 *
 * We intentionally only serialize `traceId` + `spanId` because:
 * - they're sufficient to attach the Playwright test trace to the CLI root trace
 * - they're stable and easy to validate
 *
 * If you later need sampling propagation, you can extend this schema with `traceFlags`.
 */
export const ParentSpanContextSchema = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
}).annotations({ identifier: 'ParentSpanContext' })

export type ParentSpanContext = typeof ParentSpanContextSchema.Type

/** Default env var name for passing parent span context between processes. */
export const PW_SPAN_CONTEXT_ENV_VAR = 'PW_SPAN_CONTEXT_JSON'

/**
 * Returns a schema-validated JSON string from the currently active OTEL span.
 *
 * Returns `undefined` if no OTEL span exists in the current fiber.
 * Use this to pass the span context to a child process (e.g., Playwright test runner).
 */
export const currentParentSpanContextJson: Effect.Effect<string | undefined, never, never> =
  Effect.gen(function* () {
    const span = yield* Tracer.currentOtelSpan.pipe(Effect.option)
    if (span._tag === 'None') return undefined

    const ctx = span.value.spanContext()
    return yield* Schema.encode(Schema.parseJson(ParentSpanContextSchema))({
      traceId: ctx.traceId,
      spanId: ctx.spanId,
    }).pipe(Effect.orDie)
  }).pipe(Effect.withSpan('pw.otel.currentParentSpanContextJson'))

/**
 * Creates an Effect OTEL parent span from an env var (when present and valid).
 *
 * This allows a child process (Playwright test runner) to emit spans into the same trace as the
 * parent process (CLI) by constructing an external parent span.
 *
 * @param envVar - Environment variable name to read the JSON from. Defaults to `PW_SPAN_CONTEXT_JSON`.
 */
export const parentSpanFromEnv: (
  envVar?: string,
) => Effect.Effect<ReturnType<typeof Tracer.makeExternalSpan> | undefined> = Effect.fn(
  'pw.otel.parentSpanFromEnv',
)((envVar = PW_SPAN_CONTEXT_ENV_VAR) =>
  Effect.gen(function* () {
    const raw = process.env[envVar]
    if (raw === undefined) return undefined

    const ctx = yield* Schema.decode(Schema.parseJson(ParentSpanContextSchema))(raw).pipe(
      Effect.orDie,
    )
    return Tracer.makeExternalSpan({
      traceId: ctx.traceId,
      spanId: ctx.spanId,
    })
  }),
)

/** Configuration options for the Playwright OTEL tracing layer. */
export interface OtelPlaywrightLayerConfig {
  /**
   * Service name for OTEL traces.
   * @default 'playwright'
   */
  serviceName?: string
  /**
   * Environment variable containing the OTLP endpoint URL.
   * @default 'OTEL_EXPORTER_OTLP_ENDPOINT'
   */
  endpointEnvVar?: string
  /**
   * Environment variable containing the parent span context JSON.
   * @default 'PW_SPAN_CONTEXT_JSON'
   */
  parentSpanEnvVar?: string
  /**
   * Tracer export interval in milliseconds.
   * @default 250
   */
  exportInterval?: number
}

/**
 * Creates an OTEL layer for Playwright tests.
 *
 * Features:
 * - Optionally joins an existing trace via parent span context from env var
 * - Creates root span for the Playwright test
 * - Exports to OTLP endpoint if configured
 *
 * @example
 * ```typescript
 * // Basic usage - will look for OTEL_EXPORTER_OTLP_ENDPOINT
 * const OtelLive = makeOtelPlaywrightLayer()
 *
 * // With custom config
 * const OtelLive = makeOtelPlaywrightLayer({
 *   serviceName: 'my-e2e-tests',
 *   endpointEnvVar: 'MY_OTEL_ENDPOINT',
 * })
 * ```
 */
export const makeOtelPlaywrightLayer = (
  config: OtelPlaywrightLayerConfig = {},
): Layer.Layer<never> => {
  const {
    serviceName = 'playwright',
    endpointEnvVar = 'OTEL_EXPORTER_OTLP_ENDPOINT',
    parentSpanEnvVar = PW_SPAN_CONTEXT_ENV_VAR,
    exportInterval = 250,
  } = config

  return Layer.unwrapEffect(
    Effect.gen(function* () {
      const endpoint = process.env[endpointEnvVar]
      yield* Effect.logDebug('[pw.otel] Building OTEL layer', {
        endpoint: endpoint ?? '(not set)',
      })
      const parentSpan = yield* parentSpanFromEnv(parentSpanEnvVar)

      const rootSpanLive = Layer.span('playwright.root', {
        parent: parentSpan,
        attributes: parentSpan ? { 'playwright.parentSpan._tag': parentSpan._tag } : {},
      })

      if (endpoint === undefined) {
        yield* Effect.logDebug(`[pw.otel] No ${endpointEnvVar}, skipping OTEL exporter`)
        return rootSpanLive
      }

      const exporterLive = OtlpTracer.layer({
        url: endpoint,
        resource: { serviceName },
        exportInterval,
      }).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(OtlpSerialization.layerJson),
      )

      return Layer.mergeAll(rootSpanLive, exporterLive)
    }),
  )
}

/**
 * Default OTEL layer for Playwright tests.
 *
 * Uses default configuration:
 * - Service name: 'playwright'
 * - Endpoint from: OTEL_EXPORTER_OTLP_ENDPOINT
 * - Parent span from: PW_SPAN_CONTEXT_JSON
 */
export const OtelPlaywrightLive = makeOtelPlaywrightLayer()
