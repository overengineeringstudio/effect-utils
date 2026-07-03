# Vision: vitest-otel

> **Status: DRAFT — awaiting human sign-off.** Written by an agent from a
> validated prototype; `vision.md` is human-owned. Requirements, spec, and
> decisions in this subsystem are agent-authored under explicit authority.

## The Problem

- **Problem 1 — Test runs are opaque in the task trace.** Our devenv tasks are
  traced and exported to the OTEL backend, and a run roots under the ambient
  W3C `traceparent`. But `devenv tasks run test:run` appears as a single opaque
  span: "tests took N seconds" with no interior structure. Which files were
  slow, how long collection vs execution took, where worker startup went — none
  of it is visible in the trace we already collect.

- **Problem 2 — Product telemetry is uncorrelated with the run that produced
  it.** Code under test emits Effect spans through `@effect/opentelemetry`.
  Today those spans, when exported at all, form their own root trace with no
  link to the test that exercised them. There is no single trace that shows a
  test's runner mechanics and the product behavior underneath it.

- **Problem 3 — Ad-hoc fixes threaten determinism and invite config sprawl.**
  The otelite assertion lane captures product spans in-process and asserts over
  their shape, including root-ness. Any telemetry mechanism that silently
  reparents those spans, or that must be pasted into each package's hand-written
  `vitest.config.ts`, is worse than the gap it closes.

## The Vision

- Test runs are first-class observable: the runner's own structure — worker
  start, module transform, collection, per-test timing — appears in the same
  trace as the rest of the devenv/CI task pipeline it runs under. (Problem 1)
- When investigating a slow or surprising test, one trace shows that test's
  runner span and the product spans it exercised, nested beneath it. (Problem 2)
- A single shared, governed mechanism lives in the test-support package; no
  per-package configuration, and the deterministic assertion lane is preserved
  by construction. (Problem 3)

## What This Is Not

- Not a replacement for the Effect-native `OtlpTracer` / otelite capture path.
  That remains the load-bearing, contract-governed way product code emits and
  asserts telemetry; this subsystem is additive.
- Not bulk product-span export on every CI run by default. Runner coverage is
  cheap and default-on under a collector; per-test product export is opt-in.
- Not a new telemetry backend, collector, or storage lane. It emits through the
  OTLP endpoint the devenv OTEL module already configures.
- Not a general Vitest plugin ecosystem. One curated sdkPath + one bridge.

## Success Criteria

1. `devenv tasks run test:run` under a configured collector produces the Vitest
   runner-span tree nested under the task trace, with zero per-package config
   changes.
2. With per-test product export enabled, a single test yields one trace:
   `vitest.test.runner.test.callback` → the product spans it emitted.
3. otelite assertion tests remain green and deterministic with native Vitest
   OTEL enabled for the same run.
4. Per-file overhead is small and bounded, and the whole mechanism is
   disable-able by a single environment switch.
