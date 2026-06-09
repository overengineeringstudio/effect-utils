# Requirements: 08-observability

**Role.** The opt-in `./otel` bridge: one coherent trace across server + Effect
spans, the auto-stamped span attributes (identity + error class) an operator
slices on, a replay-aware metrics baseline, and the exactly-once-on-replay
emission guarantee. Owns the traces + metrics path (replay-aware logging is on the
core `.` export — see [03-effect-runtime](../03-effect-runtime/requirements.md)).

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved.

## Requirements

### Must produce coherent, replay-correct observability

- **R23 One coherent trace:** With the OTel bridge enabled, a single invocation
  MUST produce one connected trace from the external caller through
  `ingress_invoke`, `invoke`, the attempt span, and the in-handler Effect spans,
  by sharing a single GLOBAL `TracerProvider` and a registered global context
  manager (so the hook's `trace.getActiveSpan()` resolves the attempt span) and
  parenting Effect spans under the attempt span. (Vision; [../.decisions/0007](../.decisions/0007-otel-bridge.md).)
- **R23b Operable from Grafana (attributes + metrics):** The bridge MUST make an
  invocation operable from a metrics/traces backend. On the boundary span it MUST
  auto-stamp identity (`restate.service`/`restate.handler`/`restate.object.key`)
  and, on failure, the classification (`restate.error.tag`/`restate.error.class`);
  it MUST expose `Restate.annotateSpan` for custom business attributes. A redacted
  (`sensitive`/`redacted`) field value MUST NEVER reach a span (it is PLAINTEXT
  there, bypassing serde redaction); the schema-aware `Restate.annotateSpanFrom`
  projection MUST strip such fields by default. It MUST
  register a `MeterProvider` sharing the tracer's `Resource` and emit a
  REPLAY-AWARE auto baseline (`restate_invocations_total{…,outcome}` + duration,
  per-attempt/retry, durable-step, awakeable-wait, and `pollLoop` cycle metrics)
  plus user metrics through the shared meter. ([../.decisions/0014](../.decisions/0014-observability-metrics-and-attrs.md).)
- **R24 Exactly-once-on-replay emission:** Custom span events and metric
  increments MUST be emitted exactly once across replays; replay MUST NOT
  double-emit. The PREFERRED mechanism is routing exactly-once telemetry through
  `Restate.run` closures (which run once on real execution), not gating on the
  `isReplaying` flag. The attempt and `ctx.run` spans are owned by Restate's hook
  and MUST NOT be re-emitted by the Effect layer. The auto baseline metrics (R23b)
  route through the same non-replay gate. (A04; [../.decisions/0007](../.decisions/0007-otel-bridge.md), [../.decisions/0014](../.decisions/0014-observability-metrics-and-attrs.md).)
- **R25 Replay signal exposed:** An `isReplaying` capability MUST be available to
  gate side-effecting telemetry (and for user code). It is sourced from an
  unstable internal SDK symbol, so it is version-fragile and secondary to the
  `Restate.run` mechanism (R24). ([../.decisions/0007](../.decisions/0007-otel-bridge.md).)
