# Vision: telemetry foundation

The telemetry foundation in `@overeng/utils/node` (with its schema-first
instrumentation contract in `@overeng/otel-contract`) is the single, principled
way every first-party CLI, service, and test wires OpenTelemetry. A consumer
declares the _intent_ of a process — what kind of process it is and who it is —
and gets correct trace/metric/log export, a validated resource identity, and
reliable shutdown flush out of the box. It never asks a consumer to tune export
intervals or flush timeouts, and it never lets product code reach for a raw OTEL
primitive.

## The Problem

### Problem 1: Every consumer re-derives the same export/flush mechanics

`@effect/opentelemetry`'s `Otlp.layerJson` is a capable, pure-Effect exporter,
but it exposes raw knobs: tracer/metrics/logger export intervals and a shutdown
flush timeout. Left to each binary, those knobs get hand-tuned per CLI — and the
hard-won knowledge ("a sub-second CLI must tick at least once before exit", "the
shutdown timeout is a safety _ceiling_, never a floor") is re-learned, or
mis-learned, every time. A CLI that sets the flush timeout below one collector
round-trip silently drops its final batch.

### Problem 2: Service identity is an untyped, stringly resource

The OTLP resource carries `service.name` / `service.namespace` /
`service.version`. Built from bare strings at each composition root, a malformed
or inconsistent name is invisible until it surfaces (mislabelled) in a backend.
There is no single naming law, and no edge at which a bad name is rejected.

### Problem 3: Raw OTEL primitives leak into product code

`Effect.withSpan('literal-name', { attributes })`, `Metric.counter('name')`, and
ad-hoc attribute maps scattered through product code mean span names, metric
names, attribute keys, and cardinality decisions live nowhere in particular.
Nothing enforces that an attribute key is well-formed, that a span carries the
`span.label` Grafana convention, or that a metric label is low/bounded
cardinality. The instrumentation contract is convention, not a type.

### Problem 4: Telemetry-off must cost nothing — not merely go nowhere

A CLI run with no collector configured must not pay for telemetry: not just "the
spans export to nothing", but "the periodic samplers are never forked, the
exporter is never built". Without a single resolved gate, each consumer
re-implements an `Option`-of-`Option` check against `process.env`.

### Problem 5: Test telemetry must match production telemetry

A test that asserts over captured telemetry is only meaningful if the telemetry
under test is constructed the way production constructs it — same resource
mapping, same export/flush semantics, same shape-driven defaults. A bespoke
parallel test exporter that drifts from the production front door turns green
tests into false confidence.

## The Vision

- **Select intent, not knobs.** A consumer says _what kind of process this is_
  (`Shape`: `cli` / `service` / `test`) and _who it is_ (a validated
  `ServiceIdentity`), and the foundation picks the export intervals and flush
  semantics. The raw interval/timeout knobs survive only as a rarely-needed,
  documented escape hatch. (Problem 1)
- **Identity is a type, validated at the edge.** `ServiceIdentity` is a branded
  Schema struct; a malformed `service.name` is a decode error at the composition
  root, not a backend surprise. The same branded naming law governs every signal's
  resource. (Problem 2)
- **The instrumentation contract is schema-first.** Spans, operations, metrics,
  and their attributes are declared as Schema-backed contracts in
  `@overeng/otel-contract`; product code emits through them, and a zero-allowlist
  lint (`no-raw-otel-primitives`) makes a raw OTEL primitive in product code a
  failing check. (Problem 3)
- **Telemetry-off is a true no-op.** One resolved `OtelConfig` gate, read from the
  same signal the exporter was built from, means an unconfigured run forks no
  sampler and builds no exporter. (Problem 4)
- **Reliable flush without tuning.** The final batch lands via the exporter's
  scope-close finalizer that Effect awaits to completion; the shutdown timeout is
  a safety ceiling on a black-holed collector, never a floor a consumer tunes.
  (Problem 1, cross-ref the `@overeng/tui-react` shutdown-flush contract.)
- **Test fidelity by shared front door.** Where structurally possible, test
  telemetry flows through the same front door as production; where a structural
  boundary forbids the shared import, the test path is a documented sibling whose
  knobs mirror the production `test` shape, and the test↔prod fidelity is proven
  by exercising the real front door against the same captured receiver the test
  harness uses. (Problem 5)

## What This Is Not

- **Not a telemetry abstraction over a pluggable backend.** It is a thin, typed
  front door over `@effect/opentelemetry`'s `Otlp.layerJson` (OTLP/HTTP). It does
  not hide OTEL behind a vendor-neutral facade.
- **Not a global-SDK provider.** The shared path is pure-Effect and never touches
  the `@opentelemetry/api` global registry. Consumers that genuinely require a
  globally-registered SDK `TracerProvider` (e.g. `@overeng/restate-effect`'s
  hook/bridge) keep a deliberate sibling provider layer; this foundation does not
  try to serve them.
  See [.decisions/0001-pure-effect-otlp-front-door.md](./.decisions/0001-pure-effect-otlp-front-door.md).
- **Not a re-export of every OTEL knob.** The whole point is to fold the knobs
  behind `Shape`; the `overrides` escape hatch exists for genuine edge cases and
  is expected to be rare.

## Success Criteria

1. A CLI adds telemetry with one layer — `withTelemetry({ identity, shape: 'cli',
endpoint })` — and gets traces, metrics, and logs with a validated identity on
   every signal, correct intervals, and a force-flushed final batch on exit,
   without setting any interval or timeout.
2. A raw `service.name` string at a composition root is a `tsc` error;
   construction goes through `Schema.decode(ServiceIdentity)`.
3. A raw OTEL primitive (`Effect.withSpan` literal, `Metric.counter`, ad-hoc
   attribute map) in product code fails the `no-raw-otel-primitives` check.
4. A run with no endpoint configured forks no sampler fiber and builds no
   exporter; `telemetryEnabled` is `false` and the samplers' per-tick reads never
   run.
5. The captured telemetry a test asserts over is constructed with the same
   resource mapping and the same `test`-shape export/flush semantics as
   production, and that fidelity is proven against a real captured receiver.
