# 0003 - Keep product export independent and bound its scope-close flush

Status: accepted

## Context

Vitest runner spans and Effect product spans use independent tracer providers.
Fast tests often finish before `OtlpTracer`'s periodic exporter runs, so their
product spans depend on the exporter finalizer at per-test scope close.

`@effect/opentelemetry` bounds that finalizer with `shutdownTimeout` and ignores
the export failure after the timeout. Its 3-second default can therefore drop a
product batch silently when a collector is slow even though the independently
flushed runner spans survive.

## Decision

- Keep the Effect product exporter per-test and independent from Vitest's
  global provider. This preserves service attribution, explicit parenting, and
  per-test failure isolation.
- Set `makeOtelVitestLayer`'s default `shutdownTimeout` to 15 seconds.
- Keep the native runner SDK teardown independently bounded at 2 seconds so
  unavailable observability cannot stall Vitest worker shutdown.

## Consequences

- A healthy local otelite/collector acknowledges quickly, so the larger product
  budget adds no steady-state delay.
- A slow product exporter can still extend an instrumented test by its actual
  acknowledgement time, up to 15 seconds. Product export remains opt-in.
- Runner telemetry may be abandoned earlier than product telemetry when the
  backend is unavailable; neither lane changes test correctness.
