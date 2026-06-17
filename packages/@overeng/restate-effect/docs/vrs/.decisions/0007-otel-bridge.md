# OpenTelemetry bridge behind `./otel`

## Status

accepted

## Context

Restate OTEL support must connect Restate hook spans and Effect spans into one
trace without double-emitting during replay. The Restate SDK hook reads the active
attempt span through the global `@opentelemetry/api` registry, so the binding
needs a globally registered `TracerProvider` and context manager.

Empirical checks showed `@effect/opentelemetry` `NodeSdk.layer` and
`Tracer.layerGlobal` do not by themselves install the required global context
manager. Without it, `trace.getActiveSpan()` is empty and Effect spans are
orphaned.

## Decision

- OTel remains a first-class v1 feature behind the opt-in `./otel` subpath.
- The `./otel` layer owns provider registration and global context-manager setup.
- Restate's hook owns attempt/run spans. Effect spans bridge inbound from the
  hook's active attempt span and stay on boundary operations.
- Exactly-once telemetry should prefer `Restate.run` closures. The exposed
  `isReplaying` capability uses an unstable internal SDK symbol and is not the
  preferred load-bearing mechanism.
- This layer is a deliberate sibling of `@overeng/utils/node` `withTelemetry`,
  which uses pure `Otlp.layerJson` and intentionally avoids global registration.

## Consequences

- Restate avoids duplicate/split traces by sharing one SDK provider between the
  hook and Effect.
- Core restate bindings stay dependency-light because OTEL deps live behind
  `./otel`.
- The shared convergence surface is the `@overeng/otel-contract` naming law, not
  the exporter/provider implementation.
