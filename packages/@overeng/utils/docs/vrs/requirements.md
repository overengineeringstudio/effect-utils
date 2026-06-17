# Requirements: telemetry foundation

Cross-cutting, testable constraints for the telemetry foundation. Builds on
[vision.md](./vision.md); the hard-to-reverse rationale lives in
[.decisions/](./.decisions/) and is cited by relative path. Each requirement is
a property of the as-built system, phrased so it can be checked.

## Context

- The foundation is `@overeng/utils/src/node/otel.ts` (the typed front door +
  resolved-config gate + periodic samplers), built on `@effect/opentelemetry`'s
  `Otlp.layerJson` (OTLP/HTTP, pure-Effect — no `@opentelemetry/sdk-*`,
  `@opentelemetry/api` GLOBAL untouched).
- The schema-first instrumentation contract is `@overeng/otel-contract`
  (`src/mod.ts`): the branded identity/name schemas, the `OtelOperation` /
  `OtelSpan` / `OtelMetric` Schema-backed contracts, and the
  `no-raw-otel-primitives` lint with its `raw-otel-boundary` test.
- The shutdown-flush behavior is the contract owned by `@overeng/tui-react` (its
  `docs/spec.md` Shutdown Flush section and decision
  `0001-shutdown-flush-contract.md`); this foundation consumes that contract and
  does not restate it.

## Assumptions

- **A01 OTLP/HTTP export, pure-Effect.** Export is `Otlp.layerJson` posting OTLP
  JSON over `FetchHttpClient` to a base endpoint; it builds its own Effect-native
  provider and never registers a global SDK provider or context manager. (See
  [.decisions/0001-pure-effect-otlp-front-door.md](./.decisions/0001-pure-effect-otlp-front-door.md).)
- **A02 Endpoint resolved at the edge.** The OTLP endpoint is resolved once at a
  binary's composition root as `Option<string>` and handed to the layer; the
  layer is a pure function of that input and does not read `process.env` when the
  endpoint is supplied explicitly.
- **A03 Flush is a scope finalizer.** The exporter's flush is a scope-close
  finalizer Effect awaits to completion, so the final batch lands on natural exit
  regardless of export intervals. The shutdown timeout is a ceiling on a
  black-holed collector, not a floor. (Inherited from the `@overeng/tui-react`
  shutdown-flush contract.)
- **A04 Identity is branded.** `service.name`, `service.namespace`, and
  `service.version` are branded `NonEmptyTrimmedString` schemas in
  `@overeng/otel-contract`; `ServiceIdentity` is the struct of all three.

## Tradeoffs

- **T01 Shape over per-consumer knobs.** Folding intervals/flush behind three
  shapes loses per-binary fine-tuning in exchange for one place the mechanics are
  correct. The `overrides` escape hatch recovers fine-tuning for genuine edge
  cases, at the cost of a documented deviation.
- **T02 No global SDK provider.** Refusing to register a global
  `TracerProvider` keeps `@opentelemetry/sdk-*` and a process-global side effect
  off every consumer, at the cost of not serving global-API consumers from this
  layer (they keep a sibling). (See
  [.decisions/0001](./.decisions/0001-pure-effect-otlp-front-door.md) and
  `@overeng/restate-effect` decision 0007.)
- **T03 Test path is a sibling, not a shared import.** The otelite test harness
  in `@overeng/utils-dev` cannot import the front door (a package
  dependency-direction cycle), so it mirrors the `test` shape rather than sharing
  it. (See
  [.decisions/0002-test-shape-sibling-convergence.md](./.decisions/0002-test-shape-sibling-convergence.md).)

## Requirements

### Typed identity

- **R01** `ServiceIdentity` is a branded Schema struct (`name` / `namespace` /
  `version`); a malformed `service.name` is a decode error. A raw string passed
  where an identity is required is a `tsc` error. (A04)
- **R02** The identity's `name` / `namespace` / `version` are stamped onto the
  resource of EVERY signal (traces, metrics, logs) as
  `service.name` / `service.namespace` / `service.version`. Env-provided resource
  attributes (`OTEL_RESOURCE_ATTRIBUTES` / `OTEL_SERVICE_NAME`) are still merged,
  with the explicit identity winning on collision.

### Intent-selected export (Shape)

- **R03** A consumer selects a `Shape` (`cli` / `service` / `test`); the shape —
  not the consumer — picks the tracer/metrics export intervals and the shutdown
  flush window. (T01)
- **R04** The `cli` shape uses short intervals so a sub-second run ticks at least
  once, and leaves the shutdown timeout to the TTY-aware default (the safety
  ceiling). `service` uses relaxed intervals; `test` uses short, equal intervals
  on all signals with a tight shutdown window for fast hermetic assertions.
- **R05** The raw `exportInterval` / `metricsExportInterval` / `shutdownTimeout`
  knobs are reachable only via an `overrides` escape hatch on the front door;
  reaching for them is the exception, and a deviation is expected to be
  documented. (T01)

### Schema-first instrumentation contract

- **R06** Spans, operations, metrics, and attributes are declared as
  Schema-backed contracts (`OtelOperation` / `OtelSpan` / `OtelMetric`); attribute
  keys, span/metric names, and identity names are validated by brand at definition
  time.
- **R07** Operations derive the `span.label` Grafana convention; an operation
  with an empty/missing label fails to encode. Metric labels must declare or infer
  low/bounded cardinality — a high-cardinality or drop-encoded metric label is a
  plan error.
- **R08** A raw OTEL primitive in product code — a literal `Effect.withSpan`
  name, `Metric.counter` / `Metric.histogram`, ad-hoc attribute maps — fails the
  `no-raw-otel-primitives` zero-allowlist check; the `raw-otel-boundary` test
  proves production instrumentation routes through the schema-backed helpers.

### Reliable shutdown flush without tuning

- **R09** The final batch of every signal is delivered by the exporter's
  scope-close finalizer, which Effect awaits to completion; correctness does not
  depend on tuning export intervals or the shutdown timeout. (A03)
- **R10** The shutdown timeout is a safety ceiling only: it costs nothing on a
  healthy collector and bounds only the worst case against a black-holed
  collector. A small per-CLI override is a footgun (it turns the ceiling into a
  dropped final batch) and is not the recommended path. (Cross-ref the
  `@overeng/tui-react` shutdown-flush contract; not restated here.)

### Telemetry-off no-op

- **R11** When no endpoint is configured, the layer builds no exporter (only the
  `OtelConfig` marker, `endpoint = None`) — zero exporter overhead.
- **R12** Periodic samplers (`sampleResource` / `sampleGauge`) are gated on the
  resolved `OtelConfig`; with telemetry off, no sampler fiber is forked and the
  per-tick read never runs. `telemetryEnabled` is `false` when the endpoint is
  `None` or the `OtelConfig` layer is absent.
- **R13** Samplers tick on REAL wall time (a fresh `Clock`), decoupled from any
  ambient test/fixed decision clock, so they neither hot-loop under a zero-sleep
  clock nor stall under a paused one.

### Test ↔ prod fidelity

- **R14** Test telemetry is constructed with the same resource mapping and the
  same `test`-shape export/flush semantics as production. Where the front door
  cannot be imported (dependency-direction cycle, T03), the test path mirrors the
  `test` shape with a cross-reference and the fidelity is proven by exercising the
  real front door against the same captured receiver the harness boots.
- **R15** All otelite-consuming tests assert non-vacuously: a misrouted or
  self-disabled exporter yields zero captured rows and fails the test loudly
  (the silent-failure guard).
