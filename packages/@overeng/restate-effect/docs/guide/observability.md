# OpenTelemetry (`./otel`)

[← Handbook index](./README.md)

The opt-in OTel bridge wires the external caller, the Restate server spans, the SDK
attempt/`run` spans, and your in-handler Effect spans into **one coherent trace** —
AND makes an invocation operable from Grafana with span attributes + metrics. The
otel packages live behind this subpath, so the core `.` export stays
dependency-light. The full file is [`examples/09-otel.ts`](../../examples/09-otel.ts).

```
[external caller traceparent]
        │ W3C extract (server)
        ▼
restate-server:  ingress_invoke ── invoke         (server spans)
        │ injects traceparent into attemptHeaders
        ▼
openTelemetryHook:  attempt <target> ── run (<name>)   (replay-aware)
        │ context.with(attemptContext)
        ▼  bridge: trace.getActiveSpan().spanContext() → Tracer.withSpanContext
Effect spans (schema-first Restate operation contracts)
```

## Wiring it up

```ts
import { NodeRuntime } from '@effect/platform-node'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base'
import { Effect } from 'effect'
import { serve } from '@overeng/restate-effect'
import { RestateOtel } from '@overeng/restate-effect/otel'

// `layer` registers ONE global TracerProvider + a global context manager (the
// load-bearing step that makes the attempt span resolve at handler entry), binds
// Effect's tracer to the same provider, AND — when a metric reader/exporter is
// given — registers a MeterProvider sharing the same Resource and binds Effect's
// `Metric` to it. Omit the metric config for a traces-only setup.
const OtelLayer = RestateOtel.layer({
  resource: { serviceName: 'greeter' },
  exporter: new ConsoleSpanExporter(), // a BatchSpanProcessor over OTLP in prod
  // In prod wrap a `PeriodicExportingMetricReader` over an OTLP metric exporter;
  // the in-memory reader shows the auto-baseline metrics locally without a peer dep.
  metricReader: new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
  }),
})

// `withOtel` attaches the hook + inbound span-context bridge + the boundary
// observer (span-attribute stamping) to every handler.
serve(RestateOtel.withOtel({ services: [GreeterLive], port: 9080 })).pipe(
  Effect.provide(Greeting.Default),
  Effect.provide(OtelLayer),
  NodeRuntime.runMain,
)
```

For an env-driven setup, `RestateOtel.layerConfig` reads `OTEL_SERVICE_NAME` and
`OTEL_EXPORTER_OTLP_ENDPOINT` from `Config` and hands the resolved endpoint to a
`build` you supply. The OTLP exporter package (`@opentelemetry/exporter-trace-otlp-http`,
`@opentelemetry/exporter-metrics-otlp-http`) is **your** choice — it is deliberately
not pulled into the binding's closure, so you install only the exporter your
collector needs:

```ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'

const OtelLayer = RestateOtel.layerConfig({
  base: { resource: { serviceName: 'greeter' } }, // overridden by OTEL_SERVICE_NAME
  build: ({ endpoint }) => ({
    exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricExporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
  }),
})
```

`RestateOtel.layer` MUST be present — it registers the global `TracerProvider` **and
a global context manager** (`AsyncLocalStorageContextManager`), the load-bearing step
that makes the hook's active span resolve at handler entry. Without the global
context manager, `getActiveSpan()` returns `undefined` and the inbound bridge is fed
nothing, leaving orphaned Effect spans. (Neither `NodeSdk.layer` nor
`Tracer.layerGlobal` alone register a context manager — `./otel` owns this.)

## Span attributes

The boundary auto-stamps the **attempt span** with the identity an operator slices
on:

- `restate.service` (construct name), `restate.handler` (handler name),
  `restate.object.key` (Objects/Workflows; omitted for plain Services);
- `restate.workflow.id` (the Workflow key; omitted for Services/Objects) and
  `restate.idempotency.key` (the original-invocation `idempotency-key` header;
  omitted when none) — so you slice on the end-to-end identity (producer intent →
  workflow id → idempotency key) **without hand-rolling** them via
  `Restate.annotateSpan`;
- on a **failure**: `restate.error.tag` (the domain error `_tag`) +
  `restate.error.class` (`terminal` | `retryable` | `cancelled`), read from the same
  `classifyOutcome` the SDK outcome is built on (so the span class matches exactly).

For custom **business** attributes, use `Restate.annotateSpan` in a handler — the
core, otel-free annotation API:

```ts
import { Restate } from '@overeng/restate-effect'

const sync = (input: SyncInput) =>
  Effect.gen(function* () {
    yield* Restate.annotateSpan({ dataSourceId: input.dataSourceId })
    // … now every span in this invocation is sliceable by `dataSourceId` in Tempo.
  })
```

Use the `span.label` convention for a single primary label.

To annotate a few fields of a decoded input/state SAFELY, use
`Restate.annotateSpanFrom(schema, value, pick?)`. It projects the struct to span
attributes and STRIPS every `sensitive`/`redacted` field (even one explicitly
`pick`ed), so a secret can never reach the span by accident:

```ts
// `apiToken` is `Restate.sensitive(Schema.String)` — it is NEVER stamped.
yield * Restate.annotateSpanFrom(SyncInput, input, ['dataSourceId'])
```

> **Never stamp a sensitive value onto a span attribute.** Redaction
> (`Restate.sensitive` / `redacted`, see [Annotations](./annotations.md#field-level-redaction))
> is serde-only — it encrypts the value on the wire/journal. A span attribute
> bypasses the serde and would leak the plaintext into your traces. `annotateSpan`
> takes raw primitives and cannot detect sensitivity, so prefer `annotateSpanFrom`
> (which strips sensitive fields by construction) or stamp a non-sensitive
> identifier by hand. (The auto-stamped `restate.workflow.id` /
> `restate.idempotency.key` are identity keys, not field values — a redacted field
> is encrypted in the serde and never reaches the boundary, so they are safe.)
>
> `Restate.annotateSpan` attributes are **not** replay-suppressed. For
> side-effecting telemetry (a span event, a metric increment), route it through
> `Restate.run` so it runs once on real execution and is skipped on replay.

## Metrics

When a `metricExporter`/`metricReader` is configured, the bridge emits a
REPLAY-AWARE auto baseline (exactly-once across attempts/replays):

| Metric                           | Labels                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `restate_invocations_total`      | `service`, `handler`, `outcome` (`success`/`terminal`/`retryable`/`cancelled`) |
| `restate_invocation_duration_ms` | `service`, `handler`, `outcome`                                                |
| `restate_attempts_total`         | `service`, `handler` (retries = attempts − success/terminal)                   |
| `restate_durable_steps_total`    | `step` (the `Restate.run` name)                                                |
| `restate_awakeable_wait_ms`      | —                                                                              |
| `restate_poll_loop_cycles_total` | `name`, `outcome` (`ok`/`error`/`stopped`)                                     |

The auto baseline is built from core Effect `Metric`s (otel-free), bound to OTel only
when the meter is registered — so adoption is additive (omit the metric config for an
in-memory-metrics, traces-only setup). Wall-clock elapsed is read via
`process.hrtime.bigint()` (a monotonic, non-journaled side-channel), never
`Date.now()`.

User counters/histograms export through the SAME meter (any Effect `Metric`). For
exactly-once custom telemetry, increment **inside** a `Restate.run` (journaled-once)
or gate on non-replay — preferred over the version-fragile `isReplaying` flag, which
reads an unstable internal SDK symbol.

The whole path is verified server-free with an in-memory `MetricReader` +
`SpanExporter`, including a forced-replay no-double-count assertion
([`src/observability/observability.test.ts`](../../src/observability/observability.test.ts)).

## Logging

In-handler `Effect.log*` (`logInfo` / `logWarning` / `logError` / `logDebug`) is
bridged to the invocation's **replay-aware `ctx.console`** — automatically, on the
core `.` export (no `./otel` needed). The per-invocation logger layer is provided
over every handler alongside the journaled `Clock`/`Random`, so:

- **Replayed logs are suppressed.** `ctx.console` excludes output during replay, so
  an `Effect.logInfo` does **not** re-emit on every replay/attempt — the line is
  written once, on the real execution. (A plain default logger writing to
  `globalThis.console` would re-print on each replay.)
- **Level control is free.** `ctx.console` honors the SDK's `RESTATE_LOGGING`
  level, and the bridge maps the Effect `LogLevel` to the matching console method:
  `Trace`/`Debug` → `debug`, `Info` → `info`, `Warning` → `warn`,
  `Error`/`Fatal` → `error`.
- **Context is stamped.** `ctx.console` annotates each line with the invoked
  service/handler + invocation id; the message keeps Effect's `logfmt` format, so
  log annotations (`Effect.annotateLogs`) and spans ride along.

```ts
const greet = (input: Greet) =>
  Effect.gen(function* () {
    yield* Effect.logInfo('greeting').pipe(Effect.annotateLogs('name', input.name))
    return `Hello, ${input.name}!`
  })
```

A log line is **not** a durable side effect — it is suppressed on replay but never
journaled. For side-effecting telemetry (writing to an external sink, incrementing
a business counter), route it through `Restate.run` so it runs exactly once on real
execution and is skipped on replay — the same exactly-once seam the metrics path
uses. The endpoint's own startup log (`"… endpoint listening on …"`) is outside any
handler and uses the process default logger, unaffected by this bridge.

## See also

- [Annotations and redaction](./annotations.md) — the redaction rule referenced above.
- [Durable steps](./durable-steps.md) — `Restate.run` as the exactly-once seam.
- [decision 0014](../vrs/.decisions/0014-observability-metrics-and-attrs.md) — the metrics + attrs rationale.
