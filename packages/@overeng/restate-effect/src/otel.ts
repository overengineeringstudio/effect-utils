/**
 * `@overeng/restate-effect/otel` — the opt-in OpenTelemetry bridge (R23–R25,
 * decision 0007, spec §10). Imported behind the `./otel` subpath so the otel
 * packages (`@effect/opentelemetry`, `@restatedev/restate-sdk-opentelemetry`,
 * `@opentelemetry/*`) stay OUT of the dependency-light core.
 *
 * The bridge wires three things into one coherent trace
 * (caller → `ingress_invoke` → `invoke` → `attempt` → Effect spans):
 *
 * 1. {@link RestateOtel.layer} — a scoped `Layer` that builds ONE OTel
 *    `TracerProvider` (a `NodeTracerProvider`), registers it as the API GLOBAL
 *    AND installs a global `AsyncLocalStorageContextManager` (via
 *    `provider.register()`), and shares that SAME provider with Effect's tracer
 *    (`@effect/opentelemetry` `Tracer.layer` over the provider Tag). The global
 *    registration is the LOAD-BEARING fix: empirically `NodeSdk.layer@0.63`
 *    registers neither a global provider nor a context manager, so without this
 *    the hook's `trace.getActiveSpan()` is `undefined` and Effect spans orphan.
 *
 * 2. {@link RestateOtel.hook} — wraps `openTelemetryHook` from
 *    `@restatedev/restate-sdk-opentelemetry`. The hook owns the attempt/`run`
 *    spans, inbound W3C extraction, and replay-event suppression. It is attached
 *    SERVICE-level on every materialized service (so it wraps every handler).
 *
 * 3. {@link RestateOtel.inboundBridge} — the per-invocation `HandlerWrap` that
 *    reads the hook's active attempt span (`trace.getActiveSpan()`) and
 *    reparents the Effect program under it (`Tracer.withSpanContext`).
 *
 * {@link RestateOtel.withOtel} composes all three onto a core `EndpointOptions`.
 *
 * Exactly-once-on-replay telemetry is achieved PRIMARILY by routing custom span
 * events / metric increments through `Restate.run` (runs once on real
 * execution, skipped on replay). {@link isReplaying} is exposed too, but it
 * reads a version-fragile internal SDK flag — prefer `Restate.run`.
 */

import * as Resource from '@effect/opentelemetry/Resource'
import * as EffectTracer from '@effect/opentelemetry/Tracer'
import { trace } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import {
  openTelemetryHook,
  type OpenTelemetryHookOptions,
} from '@restatedev/restate-sdk-opentelemetry'
import { Effect, Layer, type Scope } from 'effect'

import type { EndpointHooks, EndpointOptions, HandlerWrap } from './Endpoint.ts'
import { RestateContext } from './RestateContext.ts'

/** The OTel resource identity shared by the provider and the Effect tracer. */
export interface OtelResourceConfig {
  readonly serviceName: string
  readonly serviceVersion?: string
  readonly attributes?: Readonly<Record<string, string | number | boolean>>
}

/** Configuration for {@link RestateOtel.layer}. */
export interface OtelLayerConfig {
  readonly resource: OtelResourceConfig
  /**
   * How the provider exports spans. Provide a ready `spanProcessor` (e.g. a
   * `BatchSpanProcessor` over an OTLP exporter) OR a bare `exporter` (wrapped in
   * a `SimpleSpanProcessor`). A server-free test passes an `InMemorySpanExporter`.
   */
  readonly spanProcessor?: SpanProcessor
  readonly exporter?: SpanExporter
}

const toOtelResource = (config: OtelResourceConfig) =>
  resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...(config.serviceVersion !== undefined
      ? { [ATTR_SERVICE_VERSION]: config.serviceVersion }
      : {}),
    ...config.attributes,
  })

const resolveProcessor = (config: OtelLayerConfig): SpanProcessor => {
  if (config.spanProcessor !== undefined) return config.spanProcessor
  if (config.exporter !== undefined) return new SimpleSpanProcessor(config.exporter)
  throw new Error(
    'RestateOtel.layer: provide either `spanProcessor` or `exporter` to export spans.',
  )
}

/**
 * Build + globally register the shared OTel `TracerProvider`, returning it for
 * Effect to reuse. `provider.register()` installs BOTH the global provider and a
 * default `AsyncLocalStorageContextManager` — the proven prerequisite that makes
 * the hook's `trace.getActiveSpan()` resolve at handler entry (decision 0007).
 * Scoped: the finalizer shuts the provider down (flushes spans) on teardown, and
 * resets the global API state so repeated builds (e.g. tests) do not leak.
 */
const acquireProvider = (
  config: OtelLayerConfig,
): Effect.Effect<NodeTracerProvider, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const provider = new NodeTracerProvider({
        resource: toOtelResource(config.resource),
        spanProcessors: [resolveProcessor(config)],
      })
      /* Installs the global provider AND a default AsyncLocalStorageContextManager. */
      provider.register()
      return provider
    }),
    (provider) =>
      Effect.promise(() => provider.shutdown()).pipe(
        Effect.ignore,
        /* Drop the global delegate so a later `layer` re-registers cleanly. */
        Effect.ensuring(Effect.sync(() => trace.disable())),
      ),
  )

/**
 * The shared-provider scoped `Layer`. Builds + globally registers ONE
 * `TracerProvider` (+ global context manager) and binds Effect's tracer to that
 * SAME provider, so `Effect.withSpan` and the Restate hook emit into one trace.
 * Built once per scope (`Layer` memoizes the acquire), so there is no double
 * `register()`.
 */
const sharedLayer = (config: OtelLayerConfig): Layer.Layer<never, never, never> =>
  Layer.unwrapScoped(
    acquireProvider(config).pipe(
      Effect.map((provider) =>
        EffectTracer.layer.pipe(
          Layer.provide(Layer.succeed(EffectTracer.OtelTracerProvider, provider)),
          Layer.provide(Resource.layer(config.resource)),
        ),
      ),
    ),
  )

/** The default instrumentation-scope name for hook-emitted Restate spans. */
const DEFAULT_TRACER_NAME = '@overeng/restate-effect'

/**
 * The Restate `openTelemetryHook` as an {@link EndpointHooks} provider. Defaults
 * the tracer to the GLOBAL provider's tracer (the one {@link RestateOtel.layer}
 * registered), so the hook and Effect share a provider. Attach it SERVICE-level
 * (this is what {@link RestateOtel.withOtel} does).
 */
const hook = (options?: Partial<OpenTelemetryHookOptions>): EndpointHooks =>
  openTelemetryHook({
    tracer: options?.tracer ?? trace.getTracer(DEFAULT_TRACER_NAME),
    ...(options?.runSpans !== undefined ? { runSpans: options.runSpans } : {}),
    ...(options?.suppressSpanEventsDuringReplay !== undefined
      ? { suppressSpanEventsDuringReplay: options.suppressSpanEventsDuringReplay }
      : {}),
    ...(options?.additionalAttemptAttributes !== undefined
      ? { additionalAttemptAttributes: options.additionalAttemptAttributes }
      : {}),
    ...(options?.additionalRunAttributes !== undefined
      ? { additionalRunAttributes: options.additionalRunAttributes }
      : {}),
  } as OpenTelemetryHookOptions)

/**
 * The inbound bridge (R23, §10) as a core {@link HandlerWrap}. Run INSIDE the
 * handler (the hook has set the attempt span active via `context.with`), it
 * reads `trace.getActiveSpan()?.spanContext()` and reparents the Effect program
 * under it via `Tracer.withSpanContext` — so every in-handler `Effect.withSpan`
 * becomes a child of the `attempt <target>` span. A no-op (program returned
 * verbatim) when no span is active (e.g. the hook is not installed).
 */
const inboundBridge: HandlerWrap = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const spanContext = trace.getActiveSpan()?.spanContext()
  return spanContext !== undefined ? EffectTracer.withSpanContext(spanContext)(effect) : effect
}

/**
 * Compose the OTel hook + inbound bridge onto a core `EndpointOptions`. The
 * resulting options serve every service with the `openTelemetryHook` attached
 * and every handler's Effect program reparented under the attempt span. Pair
 * with {@link RestateOtel.layer} provided over the application Layer (the layer
 * registers the shared global provider the hook + bridge read).
 *
 * ```ts
 * serve(RestateOtel.withOtel({ services: [GreeterLive], port: 9080 })).pipe(
 *   Effect.provide(RestateOtel.layer({ resource: { serviceName: 'greeter' }, exporter })),
 *   Effect.provide(AppLayer),
 *   NodeRuntime.runMain,
 * )
 * ```
 */
const withOtel = <AppR>(
  opts: EndpointOptions<AppR>,
  hookOptions?: Partial<OpenTelemetryHookOptions>,
): EndpointOptions<AppR> => ({
  ...opts,
  hooks: [...(opts.hooks ?? []), hook(hookOptions)],
  inboundBridge,
})

/**
 * The OTel bridge surface. `layer` registers the shared global provider; `hook`
 * + `inboundBridge` are the per-service / per-invocation seams; `withOtel`
 * composes them onto `EndpointOptions`.
 */
export const RestateOtel = {
  layer: sharedLayer,
  hook,
  inboundBridge,
  withOtel,
} as const

/**
 * Whether the current invocation is REPLAYING journaled work (R25, §10).
 *
 * Sourced from the SDK's internal `isProcessing()` (negated) on the raw
 * `restate.Context`. VERSION-FRAGILE: it reads an internal, unstable surface
 * (`Symbol.for('@restatedev/restate-sdk/hooks.isProcessing')` is the hook-context
 * equivalent). PREFER routing exactly-once telemetry through `Restate.run`
 * closures (which execute once on real processing and are skipped on replay) —
 * that is the load-bearing seam, not this flag (decision 0007). Resolves `false`
 * defensively when the internal is unavailable (a future SDK version), so code
 * gating on it degrades to "emit" rather than throwing.
 */
export const isReplaying: Effect.Effect<boolean, never, RestateContext> = Effect.gen(function* () {
  const ctx = yield* RestateContext
  const probe = (ctx as { isProcessing?: () => boolean }).isProcessing
  if (typeof probe !== 'function') return false
  return probe.call(ctx) === false
})
