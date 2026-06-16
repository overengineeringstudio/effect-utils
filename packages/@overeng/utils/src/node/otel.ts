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
import { Config, Context, Effect, Layer, Option, Tracer } from 'effect'

import type { ServiceIdentity } from '@overeng/otel-contract'

export * from './otel-attrs.ts'

/**
 * Resolved OTEL configuration, provided by {@link makeOtelCliLayer} so command
 * code can gate optional telemetry work (e.g. forking a periodic sampler) on the
 * SAME signal the exporter was built from, instead of reading `process.env`
 * directly.
 *
 * `endpoint` is `Some(url)` when telemetry is exported and `None` otherwise. Read
 * it with {@link Effect.serviceOption} so commands stay runnable without the
 * layer (absent tag ≡ telemetry disabled), keeping the tag out of their `R`.
 */
export class OtelConfig extends Context.Tag('@overeng/utils/OtelConfig')<
  OtelConfig,
  { readonly endpoint: Option.Option<string> }
>() {}

/**
 * Resolve the OTLP endpoint at a binary's composition root via Effect `Config`,
 * returning `Option<string>` to hand straight to {@link makeOtelCliLayer}'s
 * `endpoint` field. This keeps env access at the edge: the layer itself becomes a
 * pure function of the resolved endpoint and never touches `process.env`.
 *
 * @default env var 'OTEL_EXPORTER_OTLP_ENDPOINT'
 */
export const otelEndpointFromConfig = (
  envVar = 'OTEL_EXPORTER_OTLP_ENDPOINT',
): Effect.Effect<Option.Option<string>> =>
  // `Config.option` already maps missing data to `None`; any other config error
  // (malformed value) at the composition root is a defect, so die rather than
  // widen every binary's error channel with `ConfigError`.
  Config.option(Config.string(envVar)).pipe(Effect.orDie)

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
   * Service name for OTEL traces. This identifies the CLI in trace
   * visualizations.
   *
   * Legacy: prefer the typed {@link OtelCliLayerConfig.identity}, which also
   * stamps `service.namespace` + `service.version` onto every signal's resource
   * and validates the name via the branded `OtelServiceName`. `serviceName` is
   * ignored when `identity` is provided. (Not yet `@deprecated` — the remaining
   * CLIs are migrated to `identity` first, then this is deprecated + removed.)
   */
  serviceName?: string
  /**
   * Typed, decoded service identity stamped onto the OTLP resource for ALL
   * signals (traces, metrics, logs): `service.name` + `service.namespace` +
   * `service.version`. Construct it through `Schema.decode(ServiceIdentity)` so
   * a malformed name is a type/decode error at the composition root. Takes
   * precedence over {@link OtelCliLayerConfig.serviceName}.
   */
  identity?: ServiceIdentity
  /**
   * Explicitly-resolved OTLP endpoint. When provided, it is authoritative and
   * the layer does NOT read `process.env`: `Some(url)` exports to `url`, `None`
   * disables export (empty layer). Resolve it at the binary's composition root —
   * e.g. {@link otelEndpointFromConfig} — to keep this layer a pure function of
   * its input. When omitted, the layer falls back to reading `endpointEnvVar`
   * (backward-compat for callers not yet resolving at the edge).
   */
  endpoint?: Option.Option<string>
  /**
   * Environment variable containing the OTLP endpoint URL. Only consulted when
   * `endpoint` is omitted (the explicit `endpoint` takes precedence).
   * @default 'OTEL_EXPORTER_OTLP_ENDPOINT'
   */
  endpointEnvVar?: string
  /**
   * Tracer export interval in milliseconds.
   * @default 250
   */
  exportInterval?: number
  /**
   * Metrics reader export interval in milliseconds. The OTLP metrics reader is
   * pull-based and POSTs every registered metric on this cadence; the default
   * (`@effect/opentelemetry`'s 10s) undersamples short CLI runs, so set a small
   * value when a gauge must flush within a ~10s run.
   * @default 10_000 (the @effect/opentelemetry default)
   */
  metricsExportInterval?: number
  /**
   * Safety *ceiling* for the graceful-shutdown flush, in milliseconds. The flush
   * is a scope finalizer that Effect awaits to completion, so this is a ceiling
   * never a floor: it costs nothing on a healthy collector (exit ≈ one
   * round-trip) and only bounds the worst case when the collector is
   * black-holed. Do NOT set a small per-CLI override — that turns the ceiling
   * into a dropped final batch (the cap interrupts the in-flight export).
   * @default 30_000 (non-interactive) / 10_000 (interactive TTY)
   */
  shutdownTimeout?: number
}

/**
 * Creates an OTEL layer for Effect CLI applications.
 *
 * Features:
 * - Optionally joins an existing trace via W3C TRACEPARENT env var (dt task integration)
 * - Exports to OTLP endpoint if configured (explicit `endpoint`, else env fallback)
 * - Zero exporter overhead when no endpoint is configured (only the lightweight
 *   {@link OtelConfig} marker is provided so command code can gate on it)
 * - Config-free shutdown flush: the exporter's flush is a scope finalizer Effect
 *   awaits to completion, so natural exit is as fast as the flush. `shutdownTimeout`
 *   is a safety ceiling only (see its docs) — the final batch is delivered by the
 *   scope-close finalizer regardless of the export intervals, so do NOT tune
 *   intervals or the cap to make a metric "land". Known residual: a transient
 *   mid-run export failure trips the exporter's 60s self-disable, after which the
 *   final flush short-circuits (not solvable via `shutdownTimeout`).
 *
 * @example
 * ```typescript
 * // In bin/my-cli.ts
 * import { makeOtelCliLayer } from '@overeng/utils/node/otel'
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
/**
 * Default graceful-shutdown cap. The flush is a scope finalizer Effect awaits to
 * completion, so this only bounds the worst case when the collector is
 * black-holed (never the happy path). Interactive TTYs get a tighter bound so a
 * human never waits long on a dead collector; non-interactive (CI) gets a
 * generous one. Ctrl-C escapes either in tens of ms (the flush stays
 * interruptible).
 */
const defaultShutdownTimeoutMs = (): number => (process.stdout.isTTY === true ? 10_000 : 30_000)

export const makeOtelCliLayer = (config: OtelCliLayerConfig): Layer.Layer<OtelConfig> => {
  const {
    serviceName,
    identity,
    endpoint: explicitEndpoint,
    endpointEnvVar = 'OTEL_EXPORTER_OTLP_ENDPOINT',
    exportInterval = 250,
    metricsExportInterval,
    shutdownTimeout = defaultShutdownTimeoutMs(),
  } = config

  if (identity === undefined && serviceName === undefined) {
    return Layer.die('makeOtelCliLayer requires either `identity` or `serviceName`')
  }

  // The typed `identity` is authoritative: its name/namespace/version flow onto
  // every signal's resource. The `OTEL_RESOURCE_ATTRIBUTES`/`OTEL_SERVICE_NAME`
  // env attrs are still merged in by `@effect/opentelemetry` (explicit wins on
  // collision, env-only attrs are preserved), so runtime provenance is intact.
  const resource =
    identity !== undefined
      ? {
          serviceName: identity.name,
          serviceVersion: identity.version,
          attributes: { 'service.namespace': identity.namespace },
        }
      : { serviceName: serviceName! }

  // Use Layer.suspend instead of Layer.unwrapEffect to ensure proper scope propagation.
  // Layer.unwrapEffect doesn't properly chain scopes, causing OTEL exporter finalizers
  // (which flush spans via HTTP) to not be awaited on shutdown.
  return Layer.suspend(() => {
    // The explicit `endpoint` is authoritative (pure: no env read). Only fall
    // back to `process.env` when the caller didn't resolve it at the edge.
    const resolved =
      explicitEndpoint !== undefined
        ? explicitEndpoint
        : Option.fromNullable(process.env[endpointEnvVar])

    // Always provide the resolved config so command code can gate optional
    // telemetry work on the same signal the exporter is built from.
    const configLive = Layer.succeed(OtelConfig, { endpoint: resolved })

    // No endpoint configured - return config-only layer (zero exporter overhead).
    if (Option.isNone(resolved) === true) {
      return configLive
    }

    const endpoint = resolved.value
    const parentSpan = getParentSpanFromTraceparent()

    // Propagate parent trace context from TRACEPARENT without creating a bridge span.
    // Layer.parentSpan sets the external parent so child spans (e.g. command-level
    // schema-first operation spans) appear under the dt task span in the trace.
    const parentLive = parentSpan !== undefined ? Layer.parentSpan(parentSpan) : Layer.empty

    const baseUrl = endpoint.endsWith('/') === true ? endpoint.slice(0, -1) : endpoint

    const exporterLive = Otlp.layerJson({
      baseUrl,
      resource,
      tracerExportInterval: exportInterval,
      ...(metricsExportInterval === undefined ? {} : { metricsExportInterval }),
      shutdownTimeout,
    }).pipe(Layer.provide(FetchHttpClient.layer))

    return Layer.mergeAll(configLive, parentLive.pipe(Layer.provideMerge(exporterLive)))
  })
}
