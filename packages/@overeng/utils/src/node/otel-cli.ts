/**
 * OTEL integration for Effect CLI applications.
 *
 * Provides:
 * - Parent span propagation from dt tasks (via W3C TRACEPARENT env var)
 * - OTEL exporter layer for CLI traces
 * - Zero overhead when OTEL is not configured
 *
 * Uses the @effect/opentelemetry/Otlp submodule which doesn't require
 * @opentelemetry/sdk-* peer dependencies.
 *
 * @module
 */

import * as Otlp from '@effect/opentelemetry/Otlp'
import { FetchHttpClient } from '@effect/platform'
import { Effect, Layer, Option, Tracer } from 'effect'

/**
 * Parses a W3C Trace Context TRACEPARENT header/env var.
 *
 * Format: `{version}-{trace-id}-{parent-id}-{trace-flags}`
 * Example: `00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`
 *
 * @see https://www.w3.org/TR/trace-context/#traceparent-header
 */
const parseTraceparent = (
  traceparent: string,
): { traceId: string; spanId: string; traceFlags: string } | undefined => {
  const parts = traceparent.split('-')
  if (parts.length !== 4) return undefined

  const version = parts[0]!
  const traceId = parts[1]!
  const spanId = parts[2]!
  const traceFlags = parts[3]!

  // Version must be 00 (current spec), traceId 32 hex chars, spanId 16 hex chars
  if (version !== '00' || traceId.length !== 32 || spanId.length !== 16) return undefined

  return { traceId, spanId, traceFlags }
}

/**
 * Gets the parent span from the W3C TRACEPARENT env var (when present and valid).
 *
 * This allows a CLI process to emit spans into the same trace as the
 * parent dt task by constructing an external parent span.
 *
 * The `otel-span` shell helper automatically exports TRACEPARENT for child processes,
 * so this works out of the box with dt task tracing.
 */
const getParentSpanFromTraceparent = (): Tracer.ExternalSpan | undefined => {
  const traceparent = process.env.TRACEPARENT
  if (traceparent === undefined) return undefined

  const parsed = parseTraceparent(traceparent)
  if (parsed === undefined) return undefined

  return Tracer.externalSpan({
    traceId: parsed.traceId,
    spanId: parsed.spanId,
  })
}

/**
 * Effect version of getParentSpanFromTraceparent for external use.
 */
export const parentSpanFromTraceparent: Effect.Effect<Tracer.ExternalSpan | undefined> =
  Effect.sync(getParentSpanFromTraceparent)

/** Configuration options for the CLI OTEL tracing layer. */
export interface OtelCliLayerConfig {
  /**
   * Service name for OTEL traces.
   * This identifies the CLI in trace visualizations.
   */
  serviceName: string
  /**
   * Environment variable containing the OTLP endpoint URL.
   * @default 'OTEL_EXPORTER_OTLP_ENDPOINT'
   */
  endpointEnvVar?: string
  /**
   * Tracer export interval in milliseconds.
   * @default 250
   */
  exportInterval?: number
}

/**
 * Creates an OTEL layer for Effect CLI applications.
 *
 * Features:
 * - Optionally joins an existing trace via W3C TRACEPARENT env var (dt task integration)
 * - Creates root span for the CLI invocation
 * - Exports to OTLP endpoint if configured
 * - Zero overhead when OTEL_EXPORTER_OTLP_ENDPOINT is not set
 *
 * @example
 * ```typescript
 * // In bin/my-cli.ts
 * import { makeOtelCliLayer } from '@overeng/utils/node/otel-cli'
 *
 * const baseLayer = Layer.mergeAll(
 *   NodeContext.layer,
 *   makeOtelCliLayer({ serviceName: 'my-cli' }),
 * )
 *
 * Cli.Command.run(command, { name: 'my-cli', version })
 *   (process.argv).pipe(
 *     Effect.scoped,
 *     Effect.provide(baseLayer),
 *     runTuiMain(NodeRuntime),
 *   )
 * ```
 */
export const makeOtelCliLayer = (config: OtelCliLayerConfig): Layer.Layer<never> => {
  const {
    serviceName,
    endpointEnvVar = 'OTEL_EXPORTER_OTLP_ENDPOINT',
    exportInterval = 250,
  } = config

  // Use Layer.suspend instead of Layer.unwrapEffect to ensure proper scope propagation.
  // Layer.unwrapEffect doesn't properly chain scopes, causing OTEL exporter finalizers
  // (which flush spans via HTTP) to not be awaited on shutdown.
  return Layer.suspend(() => {
    const endpoint = process.env[endpointEnvVar]

    // No endpoint configured - return empty layer (zero overhead)
    if (endpoint === undefined) {
      return Layer.empty
    }

    const parentSpan = getParentSpanFromTraceparent()

    // Create root span that optionally links to parent dt task span
    const rootSpanLive = Layer.span(`${serviceName}.root`, {
      parent: parentSpan,
      attributes: Option.fromNullable(parentSpan).pipe(
        Option.map((span) => ({ 'cli.parentSpan._tag': span._tag })),
        Option.getOrElse(() => ({})),
      ),
    })

    // Otlp.layerJson expects the base URL (it appends /v1/traces, /v1/logs, etc.)
    const baseUrl = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint

    const exporterLive = Otlp.layerJson({
      baseUrl,
      resource: { serviceName },
      tracerExportInterval: exportInterval,
    }).pipe(Layer.provide(FetchHttpClient.layer))

    return Layer.mergeAll(rootSpanLive, exporterLive)
  })
}
