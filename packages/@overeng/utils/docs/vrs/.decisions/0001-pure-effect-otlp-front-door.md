# Pure-Effect OTLP front door over a Shape-selected `Otlp.layerJson`

## Status

accepted

## Context

The foundation needs ONE way for every CLI/service to wire OTEL that does the
right thing by default. `@effect/opentelemetry` offers two export engines:

- `Otlp.layerJson` — a pure-Effect exporter that builds its own Effect-native
  provider, POSTs OTLP/HTTP itself, and touches NEITHER the `@opentelemetry/api`
  global registry NOR the `@opentelemetry/sdk-*` packages.
- `NodeSdk.layer` / a registered `NodeTracerProvider` — installs a GLOBAL SDK
  provider (and, via `provider.register()`, a global context manager), required
  by any consumer that reads the active span through the API global
  (`trace.getActiveSpan()`).

The front door also has to fold the raw export knobs
(`exportInterval` / `metricsExportInterval` / `shutdownTimeout`) so consumers do
not re-derive (or mis-derive) them. The recurring failure mode is a consumer
setting the shutdown timeout below one collector round-trip and silently dropping
its final batch.

## Decision

1. **Build on `Otlp.layerJson` exclusively.** The shared path is pure-Effect and
   never registers a global provider or context manager. This keeps
   `@opentelemetry/sdk-*` and a process-global `provider.register()` side effect
   off every CLI consumer.

2. **Intent over knobs.** `withTelemetry({ identity, shape, endpoint })` is a thin
   typed wrapper over `makeOtelCliLayer`. The `Shape` (`cli` / `service` / `test`)
   selects the intervals + flush window via `shapeDefaults`; the raw knobs survive
   only behind a rare, documented `overrides` escape hatch.

3. **Flush is a scope finalizer, the timeout is a ceiling.** The layer is built
   with `Layer.suspend` so the exporter's scope-close flush finalizer is tied to
   the layer scope and awaited to completion on natural exit. `shutdownTimeout` is
   a safety ceiling on a black-holed collector, never a floor. This foundation
   consumes — and does not restate — the `@overeng/tui-react` shutdown-flush
   contract (its decision `0001-shutdown-flush-contract.md`).

4. **Identity is decoded at the edge.** `withTelemetry` takes a branded
   `ServiceIdentity`; a raw string is a `tsc` error. Endpoint is resolved once at
   the composition root (`otelEndpointFromConfig` → `Option<string>`) so the layer
   is a pure function of its input.

## Why

- A single front door means the hard-won export/flush knowledge lives in one
  table, not re-derived per binary.
- Refusing the global registry is what makes the layer cheap and side-effect-free
  for every consumer; the few consumers that genuinely need a global provider are
  better served by a deliberate sibling than by bloating the shared layer.

## Consequences

- Consumers needing a globally-registered SDK provider (e.g.
  `@overeng/restate-effect`'s hook/bridge) keep a sibling provider layer and share
  only the naming law (the `@overeng/otel-contract` brands). See
  `@overeng/restate-effect` decision 0007 and
  [0002-test-shape-sibling-convergence.md](./0002-test-shape-sibling-convergence.md).
- A known residual: a transient mid-run export failure trips the exporter's 60s
  self-disable, after which the final flush short-circuits — not solvable via
  `shutdownTimeout` (it is a flush ceiling, not a retry policy).
