# Pure-Effect OTLP front door

## Status

accepted

## Context

The shared telemetry entry point needs one safe default for CLI/service OTEL
wiring. `Otlp.layerJson` is pure Effect and does not register an
`@opentelemetry/api` global provider or pull in SDK packages. SDK-backed
providers are still needed by consumers that read active spans from the global
registry.

The front door also centralizes export intervals and flush windows so consumers
do not re-derive fragile shutdown settings.

## Decision

- `withTelemetry({ identity, shape, endpoint })` builds on `Otlp.layerJson`.
- `shape` (`cli`, `service`, `test`) selects intervals and shutdown timeout via
  `shapeDefaults`; raw overrides stay an escape hatch.
- Flush remains a scope finalizer; `shutdownTimeout` is a black-holed-collector
  ceiling, not a delay.
- `identity` is a branded `ServiceIdentity`. The OTLP endpoint is resolved at
  the composition root and passed explicitly.

## Consequences

- Ordinary CLI consumers avoid global provider side effects and SDK dependencies.
- Consumers that need global provider registration, such as
  `@overeng/restate-effect`, keep sibling layers and share only the
  `@overeng/otel-contract` naming law.
- A transient mid-run exporter self-disable remains out of scope for the flush
  ceiling.
