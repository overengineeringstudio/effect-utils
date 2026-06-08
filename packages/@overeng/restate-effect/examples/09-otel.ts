/**
 * The opt-in OpenTelemetry bridge (`@overeng/restate-effect/otel`). It wires three
 * things into ONE coherent trace (external caller → `ingress_invoke` → `invoke` →
 * `attempt` → your in-handler Effect spans):
 *
 * 1. `RestateOtel.layer` — builds ONE OTel `TracerProvider`, registers it as the
 *    API global AND installs a global context manager (the load-bearing step that
 *    makes the hook's active span resolve at handler entry), and binds Effect's
 *    tracer to that same provider.
 * 2. `RestateOtel.hook` — the Restate `openTelemetryHook`, attached per service;
 *    it owns the attempt/`run` spans, inbound W3C extraction, and replay
 *    suppression.
 * 3. `RestateOtel.inboundBridge` — reparents each handler's Effect program under
 *    the active attempt span.
 *
 * `RestateOtel.withOtel(endpointOptions)` composes the hook + bridge + the boundary
 * observer onto the core `EndpointOptions`; pair it with `RestateOtel.layer`
 * provided over the application Layer. The otel packages live behind this subpath
 * only, so the core `.` export stays dependency-light.
 *
 * Beyond traces, the bridge makes an invocation OPERABLE from Grafana (decision
 * 0014): the boundary observer auto-stamps identity + error-class SPAN ATTRIBUTES,
 * `Restate.annotateSpan` adds custom business attributes, and `RestateOtel.layer`
 * registers a `MeterProvider` (sharing the tracer's `Resource`) that emits a
 * replay-aware auto baseline of METRICS (`restate_invocations_total{…,outcome}`,
 * duration/attempt/durable-step/awakeable-wait/`pollLoop`-cycle).
 *
 * For exactly-once-on-replay custom telemetry, route span events / metric
 * increments through `Restate.run` (runs once on real execution, skipped on
 * replay) — the load-bearing seam, preferred over the version-fragile
 * `isReplaying` flag.
 */
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base'
import { Effect, Layer } from 'effect'

import { layer, Restate, type RestateError, serve } from '../src/mod.ts'
import { RestateOtel } from '../src/otel.ts'
import { Greeting, GreeterLive } from './01-service.ts'

/* The shared-provider Layer. In production use a `BatchSpanProcessor` over an OTLP
 * trace exporter + a `PeriodicExportingMetricReader` over an OTLP METRIC exporter;
 * a `ConsoleSpanExporter` + an in-memory metric reader are fine to see the
 * one-trace + auto-baseline-metrics story locally. The `metricReader` is what turns
 * the metrics path ON — omit it for a traces-only setup. */
export const OtelLayer = RestateOtel.layer({
  resource: { serviceName: 'greeter', serviceVersion: '1.0.0' },
  exporter: new ConsoleSpanExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
  }),
})

/* `withOtel` attaches the hook + inbound bridge + the boundary observer (which
 * auto-stamps `restate.service`/`restate.handler`/`restate.object.key` and, on a
 * failure, `restate.error.{tag,class}` on the attempt span) to every served
 * handler. */
export const tracedEndpointOptions = RestateOtel.withOtel({
  services: [GreeterLive],
  port: 9080,
})

/**
 * The USER span-attribute path: `Restate.annotateSpan` stamps custom business
 * attributes on the current span (reparented under the attempt span), so traces
 * are sliceable by your own dimensions (e.g. a tenant / data-source id) in Tempo.
 */
export const annotatedGreet = (name: string) =>
  Effect.gen(function* () {
    yield* Restate.annotateSpan({ tenant: name, 'span.label': name })
    return `Hello, ${name}!`
  })

/**
 * The traced endpoint `Layer`: the application Layer + the OTel Layer, both
 * provided. `OtelLayer` MUST be present (it registers the global provider the hook
 * and bridge read).
 */
export const TracedEndpointLayer: Layer.Layer<never, RestateError, never> = layer(
  tracedEndpointOptions,
).pipe(Layer.provide(Layer.merge(Greeting.Default, OtelLayer)))

/** The traced `serve` form (wrap with `NodeRuntime.runMain` in production). */
export const tracedServeProgram: Effect.Effect<never, RestateError, never> = serve(
  tracedEndpointOptions,
).pipe(Effect.provide(Layer.merge(Greeting.Default, OtelLayer)))
