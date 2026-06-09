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

import * as EffectMetrics from '@effect/opentelemetry/Metrics'
import * as Resource from '@effect/opentelemetry/Resource'
import * as EffectTracer from '@effect/opentelemetry/Tracer'
import { type Span, trace } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { MetricReader, PushMetricExporter } from '@opentelemetry/sdk-metrics'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import type { SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import {
  openTelemetryHook,
  type OpenTelemetryHookOptions,
} from '@restatedev/restate-sdk-opentelemetry'
import { Config, type ConfigError, Effect, Layer, Option, type Scope } from 'effect'

import type {
  BoundaryObserver,
  BoundaryOutcome,
  EndpointHooks,
  EndpointOptions,
  HandlerWrap,
} from './Endpoint.ts'
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
  /**
   * How Effect `Metric`s export (the auto baseline + user metrics, decision 0014).
   * Provide a ready `metricReader` (e.g. a `PeriodicExportingMetricReader` over an
   * OTLP metric exporter, or an `InMemoryMetricExporter`-backed reader in a test)
   * OR a bare `metricExporter` (wrapped in a `PeriodicExportingMetricReader`). When
   * NEITHER is given, NO `MeterProvider` is registered — traces still work and the
   * Effect metrics stay in-memory (the metrics path is opt-in within `./otel`).
   */
  readonly metricReader?: MetricReader
  readonly metricExporter?: PushMetricExporter
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
 * Resolve the optional metric reader (decision 0014). A ready `metricReader` wins;
 * otherwise a bare `metricExporter` is wrapped in a `PeriodicExportingMetricReader`.
 * `undefined` when neither is configured — the metrics path is then OFF (traces
 * only), so adopting metrics is a purely additive config change.
 */
const resolveMetricReader = (config: OtelLayerConfig): MetricReader | undefined => {
  if (config.metricReader !== undefined) return config.metricReader
  if (config.metricExporter !== undefined) {
    return new PeriodicExportingMetricReader({ exporter: config.metricExporter })
  }
  return undefined
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
 * When a metric reader is configured it ALSO binds Effect's `Metric` to an OTel
 * `MeterProvider` SHARING the SAME `Resource` (decision 0014) — so the auto
 * baseline + user metrics export with the same `service.name`/identity as the
 * traces. The metric layer is scoped (`@effect/opentelemetry`'s `Metrics.layer`
 * registers the producer + shuts the reader down on teardown). Built once per
 * scope (`Layer` memoizes the acquire), so there is no double `register()`.
 */
const sharedLayer = (config: OtelLayerConfig): Layer.Layer<never, never, never> =>
  Layer.unwrapScoped(
    acquireProvider(config).pipe(
      Effect.map((provider) => {
        const resourceLayer = Resource.layer(config.resource)
        const tracerLayer = EffectTracer.layer.pipe(
          Layer.provide(Layer.succeed(EffectTracer.OtelTracerProvider, provider)),
        )
        const metricReader = resolveMetricReader(config)
        const metricsLayer =
          metricReader !== undefined ? EffectMetrics.layer(() => metricReader) : Layer.empty
        return Layer.merge(tracerLayer, metricsLayer).pipe(Layer.provideMerge(resourceLayer))
      }),
    ),
  )

/**
 * The env-driven `Config` inputs {@link layerConfig} reads (the OTel standard env
 * vars): the service name (`OTEL_SERVICE_NAME`) and the OTLP collector endpoint
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`). Both OPTIONAL so a missing config degrades to
 * the supplied defaults — `layerConfig` never fails the layer on absent env.
 */
export interface OtelConfigValues {
  readonly serviceName: Option.Option<string>
  readonly endpoint: Option.Option<string>
}

const otelConfig: Config.Config<OtelConfigValues> = Config.all({
  serviceName: Config.option(Config.string('OTEL_SERVICE_NAME')),
  endpoint: Config.option(Config.string('OTEL_EXPORTER_OTLP_ENDPOINT')),
})

/**
 * Configuration-driven variant of {@link sharedLayer} (spec §10, decision 0014).
 * Reads the OTel STANDARD env vars via `Config` — `OTEL_SERVICE_NAME` (service
 * identity) and `OTEL_EXPORTER_OTLP_ENDPOINT` (the OTLP collector base URL) — then
 * hands them to a caller-supplied `build` that returns the literal
 * {@link OtelLayerConfig}. The binding does NOT import an OTLP exporter package
 * (that would pull a heavy, environment-specific dep into the closure), so the
 * EXPORTER stays the caller's choice: `build` receives the resolved endpoint and
 * service name and constructs the exporter(s) it wants (an OTLP exporter in prod,
 * an in-memory exporter in a test).
 *
 * `base.resource.serviceName` is overridden by `OTEL_SERVICE_NAME` when set, so a
 * deployment can rename the service via env alone.
 *
 * ```ts
 * RestateOtel.layerConfig({
 *   base: { resource: { serviceName: 'greeter' } },
 *   build: ({ endpoint }) => ({
 *     exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
 *     metricExporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
 *   }),
 * })
 * ```
 */
const layerConfig = (opts: {
  readonly base: Omit<OtelLayerConfig, 'resource'> & {
    readonly resource: OtelResourceConfig
  }
  readonly build?: (resolved: {
    readonly endpoint: string | undefined
    readonly serviceName: string
  }) => Omit<OtelLayerConfig, 'resource'>
}): Layer.Layer<never, ConfigError.ConfigError> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const values = yield* otelConfig
      const serviceName = Option.getOrElse(values.serviceName, () => opts.base.resource.serviceName)
      const endpoint = Option.getOrUndefined(values.endpoint)
      const built = opts.build?.({ endpoint, serviceName }) ?? {}
      const config: OtelLayerConfig = {
        ...opts.base,
        ...built,
        resource: { ...opts.base.resource, serviceName },
      }
      return sharedLayer(config)
    }),
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

/* Map a boundary failure outcome to the `restate.error.class` span label (the
 * operator slices error rates on this). `suspended`/`defect` are not stamped (a
 * suspension is not a failure; a defect leaves the hook to record the exception). */
const errorClassOf = (
  outcome: BoundaryOutcome,
): 'terminal' | 'retryable' | 'cancelled' | undefined => {
  switch (outcome._tag) {
    case 'terminal':
      return 'terminal'
    case 'retryable':
      return 'retryable'
    case 'cancelled':
      return 'cancelled'
    default:
      return undefined
  }
}

/**
 * The boundary observer (R23, §10, decision 0014) as a core {@link BoundaryObserver}.
 * At handler entry it captures the hook's ACTIVE attempt span and AUTO-stamps the
 * business identity an operator slices on in Tempo/Grafana:
 *
 * - `restate.object.key` (the Object/Workflow key; omitted for plain Services),
 * - `restate.service` (the construct name), `restate.handler` (the handler name).
 *
 * On a FAILURE outcome it ALSO stamps the classification the boundary already read
 * at `classifyOutcome` — `restate.error.tag` (the domain error `_tag`) and
 * `restate.error.class` (`terminal` | `retryable` | `cancelled`) — so error-rate
 * panels can split by classification WITHOUT re-deriving it. Stamps onto the
 * attempt span directly (NOT the Effect span), so the attributes ride the span the
 * hook owns. A no-op when no span is active (the hook is not installed).
 */
const boundaryObserver: BoundaryObserver = (info) => {
  /* Read the active attempt span ONCE at entry (the hook set it active via
   * `context.with` around this fn). The `outcome` callback closes over it so it
   * stamps the SAME span at exit. */
  const span: Span | undefined = trace.getActiveSpan()
  if (span === undefined) return () => {}
  span.setAttribute('restate.service', info.service)
  span.setAttribute('restate.handler', info.handler)
  if (info.key !== undefined) span.setAttribute('restate.object.key', info.key)
  return (outcome) => {
    const errorClass = errorClassOf(outcome)
    if (errorClass !== undefined) span.setAttribute('restate.error.class', errorClass)
    if (
      (outcome._tag === 'terminal' || outcome._tag === 'retryable') &&
      outcome.errorTag !== undefined
    ) {
      span.setAttribute('restate.error.tag', outcome.errorTag)
    }
  }
}

/**
 * Compose the OTel hook + inbound bridge + boundary observer onto a core
 * `EndpointOptions`. The resulting options serve every service with the
 * `openTelemetryHook` attached, every handler's Effect program reparented under
 * the attempt span, and the boundary span stamped with identity + error-class
 * attributes (decision 0014). Pair with {@link RestateOtel.layer} provided over
 * the application Layer (the layer registers the shared global provider the hook +
 * bridge read, and — when a metric reader is configured — the shared meter the
 * auto baseline metrics export through).
 *
 * ```ts
 * serve(RestateOtel.withOtel({ services: [GreeterLive], port: 9080 })).pipe(
 *   Effect.provide(RestateOtel.layer({ resource: { serviceName: 'greeter' }, exporter, metricExporter })),
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
  boundaryObserver,
})

/**
 * The OTel bridge surface. `layer` registers the shared global provider (+ the
 * shared meter when a metric reader is configured); `hook` + `inboundBridge` are
 * the per-service / per-invocation TRACE seams; `boundaryObserver` is the
 * per-invocation span-attribute stamper (identity + error class, decision 0014);
 * `withOtel` composes them all onto `EndpointOptions`.
 */
export const RestateOtel = {
  layer: sharedLayer,
  /**
   * `Config`-driven {@link sharedLayer}: reads `OTEL_SERVICE_NAME` /
   * `OTEL_EXPORTER_OTLP_ENDPOINT` from the environment and hands them to a
   * caller-supplied exporter `build` (the exporter package is NOT pulled into the
   * closure — the caller chooses it). See {@link layerConfig}.
   */
  layerConfig,
  hook,
  inboundBridge,
  boundaryObserver,
  withOtel,
} as const

/**
 * The auto baseline metric definitions (decision 0014), re-exported from `./otel`
 * for discoverability — they are Effect `Metric`s defined in the core (no otel
 * import) and bound to the OTel meter by {@link RestateOtel.layer}. `annotateSpan`
 * (the user span-attribute combinator) is exposed on the core `Restate` namespace.
 */
export {
  invocationsTotal,
  invocationDurationMs,
  attemptsTotal,
  durableStepsTotal,
  awakeableWaitMs,
  pollLoopCyclesTotal,
} from './Metrics.ts'

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
