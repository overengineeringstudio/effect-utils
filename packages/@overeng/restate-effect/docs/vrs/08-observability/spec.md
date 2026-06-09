# Spec: 08-observability

Specifies the OpenTelemetry bridge (`./otel`): one coherent trace, span
attributes (identity + error class), and the metrics path. Builds on
[../requirements.md](../requirements.md) + [./requirements.md](./requirements.md);
terms in [../glossary.md](../glossary.md); rationale in
[../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the index.
Replay-aware in-handler logging (R37) is on the core `.` export — see
[03-effect-runtime](../03-effect-runtime/spec.md#logging--logger--replay-aware-ctxconsole).

Traces: R23–R25, R03. See
[../.decisions/0007](../.decisions/0007-otel-bridge.md). Span attributes + the
metrics path: [../.decisions/0014](../.decisions/0014-observability-metrics-and-attrs.md).

## 1. OpenTelemetry bridge (`./otel`)

```
[external caller traceparent]
        │ W3C extract (server)
        ▼
restate-server:  ingress_invoke ── invoke         (server spans)
        │ injects traceparent into attemptHeaders
        ▼
openTelemetryHook:  attempt <target> ── run (<name>)   (replay-aware, one per attempt / real run)
        │ context.with(attemptContext)
        ▼  bridge: trace.getActiveSpan().spanContext() → Tracer.withSpanContext
Effect spans (Effect.withSpan on boundary ops)
```

- The binding attaches `@restatedev/restate-sdk-opentelemetry`'s
  `openTelemetryHook` to every service. The hook owns the attempt and `ctx.run`
  spans, inbound W3C extraction, replay event suppression, and
  `recordException`-skip on suspension. The Effect layer MUST NOT re-emit them
  (R24).
- A single GLOBAL `TracerProvider` is shared with Effect via
  `@effect/opentelemetry`'s `NodeSdk.layer`, AND a global context manager
  (`AsyncLocalStorageContextManager` / AsyncHooks) MUST be registered, so the
  hook's `trace.getActiveSpan()` resolves the attempt span at handler entry.
  Without the global context manager, `getActiveSpan()` returns `undefined` and
  the inbound bridge is fed nothing → orphaned Effect spans. This is a PROVEN-required
  step: empirically `NodeSdk.layer@0.63` registers NEITHER the global provider NOR
  a context manager, and `Tracer.layerGlobal` only sets the provider (no context
  manager) — INSUFFICIENT. The `./otel` layer MUST therefore itself call
  `provider.register()` (installs the global provider AND a default
  `AsyncLocalStorageContextManager`) OR `trace.setGlobalTracerProvider(provider)` +
  `context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())`.
  A hard prerequisite the binding owns (see
  [../.decisions/0007](../.decisions/0007-otel-bridge.md)).
- At handler entry the boundary reads `trace.getActiveSpan()?.spanContext()` and
  applies `Tracer.withSpanContext`, parenting all in-handler Effect spans under
  the attempt span → one coherent trace (R23).
- Exactly-once emission (R24) is PRIMARILY achieved by routing custom span events
  / metric increments through `Restate.run` closures (which run once on real
  execution, skipped on replay). The `isReplaying` service is ALSO exposed (and
  usable by user code), but it reads an unstable internal SDK symbol
  (`Symbol.for("@restatedev/restate-sdk/hooks.isProcessing")`) — version-fragile,
  so `Restate.run` is the load-bearing seam, not the flag (R25).

## 2. Span attributes (identity + error class + user attrs)

The boundary AUTO-stamps the business identity an operator slices on, onto the
hook's `attempt <target>` span (decision 0014):

- `restate.service` (construct name), `restate.handler` (handler name),
  `restate.object.key` (Object/Workflow key; omitted for plain Services).
- `restate.workflow.id` (the Workflow key; omitted for Services/Objects) and
  `restate.idempotency.key` (the original-invocation `idempotency-key` header;
  omitted when none) — auto-stamped so a consumer slices on the end-to-end
  identity (producer intent → workflow id → idempotency key) WITHOUT hand-rolling
  them. These are IDENTITY values, never a `sensitive`/redacted FIELD (a redacted
  field is encrypted in the serde and never reaches the boundary seam), so the
  "never a redacted value on a span" rule holds.
- On a FAILURE: `restate.error.tag` (the domain error `_tag`) + `restate.error.class`
  (`terminal` | `retryable` | `cancelled`) — read from the boundary's
  `classifyOutcome` (the single source of truth `toTerminal` is built on, so the
  span class matches the SDK outcome exactly; see
  [04-error-boundary](../04-error-boundary/spec.md#error-boundary)).

The seam is a PURE core `BoundaryObserver` (`(BoundaryInfo) => (BoundaryOutcome) =>
void`, NO otel type), wired next to the inbound-bridge `HandlerWrap`; `./otel`
supplies the impl that reads `trace.getActiveSpan()` and stamps it, the otel-free
core leaves it undefined. The USER path is `Restate.annotateSpan(attrs)` — a thin
otel-free combinator over `Effect.annotateCurrentSpan` on the core `Restate`
namespace — for business attributes (e.g. `dataSourceId`) on the current Effect
span (reparented under the attempt span); use the `span.label` convention for a
single primary label.

A span attribute is PLAINTEXT — the serde's field-level redaction does NOT cover
this path, so the "never a redacted value on a span" rule (decision 0014) must hold
for the USER surface too. `Restate.annotateSpan(attrs)` takes raw primitives and
cannot detect sensitivity, so for the common "annotate a few non-secret fields of my
decoded input/state" case the SAFE-BY-DEFAULT surface is
`Restate.annotateSpanFrom(schema, value, pick?)`: it projects a decoded struct to
span attributes and STRIPS every `Restate.sensitive`/`redacted` field (even if
explicitly `pick`ed), using the SAME `findSensitiveFields` walk the serde redaction
uses as the single source of truth — so the span projection and the serde can never
disagree about what is secret, closing the leak path a free-form `annotateSpan`
otherwise left open.

## 3. Metrics path (`RestateOtel.layer({ metricReader?/metricExporter? })`)

`RestateOtel.layer` registers a `MeterProvider` SHARING the tracer's `Resource`
(via `@effect/opentelemetry`'s `Metrics.layer` over an `@opentelemetry/sdk-metrics`
`MetricReader`) and binds Effect's `Metric` to it. Neither config given → no meter
(traces-only); metrics are then in-memory Effect metrics, so adoption is additive.
The baseline metrics are core Effect `Metric`s (`Metrics.ts`, otel-free), bound to
OTel only when the meter is registered — keeping the otel/metrics deps scoped to
`./otel` (R03).

The auto baseline, with the REPLAY-AWARE exactly-once seam chosen per metric (all
gated through `emitWhenProcessing(ctx, …)` on `ctx.isProcessing()`):

| Metric                                                    | Seam (exactly-once)                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `restate_invocations_total{service,handler,outcome}`      | boundary EXIT, final classification; a `retryable` failed attempt counts per real attempt (retry pressure). |
| `restate_invocation_duration_ms{service,handler,outcome}` | boundary (monotonic start → exit).                                                                          |
| `restate_attempts_total{service,handler}`                 | boundary ENTRY; retries derive as `attempts − invocations{success\|terminal}`.                              |
| `restate_durable_steps_total{step}`                       | inside `Restate.run` (the `ctx.run` body runs once / skipped on replay).                                    |
| `restate_awakeable_wait_ms`                               | at awakeable resolution (replay reproduces instantly — not a real wait).                                    |
| `restate_poll_loop_cycles_total{name,outcome}`            | inside the `pollLoop` `cycle` handler (`ok`/`error`/`stopped`).                                             |

Wall-clock elapsed is read via `process.hrtime.bigint()` (monotonic, non-journaled
side-channel — never feeds journaled state), not `Date.now()`. USER metrics export
through the SAME meter; to be exactly-once a user counter must be incremented
INSIDE a `Restate.run` (journaled-once) or gated on non-replay (`emitWhenProcessing`
is the reusable gate). The whole path is verified server-free with an in-memory
`MetricReader` + `SpanExporter`, including a forced-replay no-double-count assertion
(`src/observability.test.ts`).

The traces + metrics deps live behind `./otel` so the core stays dependency-light
(R03, A09). Logging (see
[03-effect-runtime](../03-effect-runtime/spec.md#logging--logger--replay-aware-ctxconsole))
is the exception — it is on the core `.` export.
