# Operability: boundary span attributes + a replay-aware metrics path

The v1 OTel bridge ([decision 0007](./0007-otel-bridge.md)) exports TRACES ONLY,
and the only span attributes are the hook's `restate.invocation.{id,target}`. A
real stress run's verdict was that the package is "not operable from Grafana — no
metrics, no business identity on spans, no error classification on spans". This
decision closes that gap with two additions, both behind the `./otel` subpath so
the core stays dependency-light (R03), plus a user path on the core `Restate`
namespace.

## 1. Span attributes (auto identity + error class, + a user combinator)

The boundary AUTO-stamps the business identity an operator slices on, onto the
hook's `attempt <target>` span (the span the hook owns and W3C-parents):

- `restate.service` (construct name), `restate.handler` (handler name),
- `restate.object.key` (the Object/Workflow key; omitted for plain Services).

On a FAILURE it ALSO stamps the classification the boundary ALREADY computes at
`classifyOutcome` (the single source of truth `toTerminal` is built on), so an
error-rate panel splits by classification without re-deriving it:

- `restate.error.tag` — the domain error `_tag`,
- `restate.error.class` — `terminal` | `retryable` | `cancelled`.

The seam is a PURE core `BoundaryObserver` — `(BoundaryInfo) => (BoundaryOutcome)
=> void` with NO otel type — wired into the per-invocation boundary alongside the
existing inbound-bridge `HandlerWrap`. `./otel` supplies the implementation that
reads `trace.getActiveSpan()` and stamps it; the otel-free core leaves it
undefined. This mirrors the dependency-light split decision 0007 already uses for
the inbound bridge.

The USER path is `Restate.annotateSpan(attrs)` — a thin combinator over
`Effect.annotateCurrentSpan` (otel-free, on the core `Restate` namespace) — so a
handler stamps business attributes (e.g. `dataSourceId`) onto the current Effect
span (reparented under the attempt span by the inbound bridge), for slicing in
Tempo/Grafana. Use the `span.label` convention for a single primary label.

## 2. Metrics path in `RestateOtel`

`RestateOtel.layer({ …, metricReader?/metricExporter? })` registers a
`MeterProvider` SHARING THE SAME `Resource` as the tracer (via
`@effect/opentelemetry`'s `Metrics.layer` over an `@opentelemetry/sdk-metrics`
`MetricReader` — a `PeriodicExportingMetricReader` over a consumer-provided OTLP
metric exporter in production, an in-memory reader in a test) and binds Effect's
`Metric` to it. When NEITHER `metricReader` nor `metricExporter` is given, no meter
is registered — traces still work and the metrics stay in-memory, so adopting
metrics is a purely additive config change. `@opentelemetry/sdk-metrics` is an
`./otel` peer dep (it was already a dev dep via `otelSdkDeps`).

The baseline metrics are defined as Effect `Metric`s in a CORE `Metrics.ts` module
— `effect` is already a core dependency, so the definitions carry NO otel import,
and the same counters/histograms are bound to the OTel meter only when
`RestateOtel.layer` provides it. This is the cleanest way to keep otel/metrics deps
scoped to `./otel` while emitting from core combinators.

### Replay-aware exactly-once — the subtle part

An invocation re-runs its handler on every attempt AND replays journaled work, so
a naive increment double-counts across attempts/replays. The single seam is
`emitWhenProcessing(ctx, …)`, which gates every auto emit on the raw context's
`ctx.isProcessing()` (the SAME non-replay signal the hook uses to suppress span
events). The seam chosen for EACH baseline metric:

| Metric                                                    | Seam                                                 | Why exactly-once                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restate_invocations_total{service,handler,outcome}`      | boundary EXIT, final classification                  | gated on non-replay; a replay re-reaching the boundary is suppressed. A `retryable` failed attempt counts on every real attempt — that IS the retry-pressure signal. |
| `restate_invocation_duration_ms{service,handler,outcome}` | boundary (monotonic start → exit)                    | same non-replay gate; measures the real finishing attempt.                                                                                                           |
| `restate_attempts_total{service,handler}`                 | boundary ENTRY                                       | per real (processing) attempt; retries derive as `attempts − invocations{outcome=success\|terminal}`.                                                                |
| `restate_durable_steps_total{step}`                       | inside `Restate.run` (after the journaled `ctx.run`) | the `ctx.run` body runs once on real execution and is skipped on replay, so gating the increment makes the step counted exactly once across attempts.                |
| `restate_awakeable_wait_ms`                               | at the awakeable `promise` resolution                | gated on non-replay (a replay reproduces the journaled completion instantly — not a real wait).                                                                      |
| `restate_poll_loop_cycles_total{name,outcome}`            | inside the `pollLoop` exclusive `cycle` handler      | each real cycle counted once; a data/count-driven stop reads `stopped`, a `skipToNext`/`stopLoop` failure reads `error`.                                             |

Wall-clock elapsed (`invocation_duration`, `awakeable_wait`) is read via
`process.hrtime.bigint()` (monotonic), NOT `Date.now()` — both because monotonic is
correct for durations and because it is a non-journaled observability side-channel
that never feeds journaled state (so it does not break deterministic replay; the
`overeng/no-raw-nondeterminism` lint targets `Date.now()` reads that could leak
into the journal, which this is not).

### User metrics

User counters/histograms are exposed through the SAME shared meter (any Effect
`Metric` exports once `RestateOtel.layer` binds the meter). To be exactly-once a
user counter must be incremented INSIDE a `Restate.run` (journaled-once) or gated
on non-replay — documented in the README + spec §10; `emitWhenProcessing` is the
reusable gate.

## Why

- "Proper OTel support" is a headline requirement (R23–R25); traces alone are not
  operable. Identity on spans enables per-tenant/per-handler slicing; error class
  on spans enables error-rate-by-classification panels; the metrics give RED
  (rate/errors/duration) + retry pressure + durable-step/awakeable/cycle signals.
- Routing the auto emission through the SAME non-replay gate the hook uses for
  span events keeps the replay-double-count guarantee consistent across spans,
  events, and metrics — the load-bearing correctness property (R24).
- Keeping the metric DEFINITIONS as core Effect `Metric`s (otel-free) and binding
  them to OTel only in `./otel` keeps the core dependency-light (R03) while still
  letting core combinators emit.

## Consequences

- `RestateOtel.layer` gains the optional `metricReader`/`metricExporter` config;
  `withOtel` now also wires the `boundaryObserver`. The boundary observer + the
  baseline metric emits run on EVERY served handler when `./otel` is wired — so
  they stay cheap (synchronous attribute sets / gated metric updates) and a no-op
  in the otel-free core.
- `classifyOutcome` is the single source of truth for the SDK throw value AND the
  span/metric outcome label; `toTerminal` is a thin unwrap of it. They cannot
  drift.
- The metrics seam is verified server-free with an in-memory `MetricReader` +
  `SpanExporter`, including a forced-replay assertion that the durable-step counter
  does NOT double-count (`src/observability.test.ts`).

Status: accepted
