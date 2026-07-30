# Requirements: vitest-otel

## Context

- Builds on [vision.md](./vision.md).
- Builds on existing effect-utils packages and systems:
  - `@overeng/utils-dev` `node-vitest` — the shared test harness (`withTestCtx`,
    `makeOtelVitestLayer`, `otlpTracesUrl`) that every package's tests import.
  - `@overeng/utils-dev` `otelite` — the in-process OTLP capture bridge used by
    the assertion lane ([vitest-bridge](../../packages/@overeng/utils-dev/src/otelite/vitest-bridge.ts)).
  - `@effect/opentelemetry` `OtlpTracer` — the lightweight, dependency-free
    Effect tracer the harness uses; it parents spans only from the Effect-level
    parent, never from the global OTEL context.
  - The devenv OTEL module (`nix/devenv-modules/otel.nix`) which configures
    `OTEL_EXPORTER_OTLP_ENDPOINT` and injects a `TRACEPARENT` per task.
- Depends on Vitest's `experimental.openTelemetry` support (Vitest ≥ 4.1.9,
  pinned `4.1.9`). The feature is experimental; see **T05**.

## Assumptions

- **A01 Vitest emits an active runner span:** Vitest's native OTEL wraps each
  test callback in a span (`vitest.test.runner.test.callback`) made active in
  the global `@opentelemetry/api` context for the duration of the callback.
- **A02 Single global OTEL API:** `@opentelemetry/api` registers its context
  manager under a major-version-keyed global symbol, so the runner SDK and the
  harness share one active context even across physical package copies.
- **A03 Collector context is the enable signal:** Under devenv/CI a collector
  endpoint and a `TRACEPARENT` are present; a bare local/watch run has neither.
- **A04 OtlpTracer parents from the Effect parent only:** The harness tracer
  inherits `traceId`/`parentSpanId` solely from an Effect-level parent span, so
  a cross-context parent must be seeded explicitly.
- **A05 Assertion lane runs in the main suite:** otelite capture tests are
  ordinary unit tests (`*.unit.test.ts` / `*.test.ts`) that run in the same
  invocation as everything else; lane separation cannot rely on a separate task.

## Acceptable Tradeoffs

- **T01 Explicit bridge over global patching:** Product spans are nested by
  reading the active runner span once and seeding it as an explicit Effect
  parent, not by routing the harness tracer through the global provider. This
  trades a small amount of wiring for keeping the harness tracer independent and
  the parent handoff auditable.
- **T02 Runner coverage default-on, product export opt-in:** Runner spans are
  low-volume structural timing and export by default under a collector;
  per-test product spans are high-volume and export only when explicitly
  enabled. This trades a fully-unified default trace for bounded trace volume.
- **T03 Runner span names are ungoverned externals:** `vitest.*` span names are
  emitted by Vitest, outside the `otel-contract` registry and the
  `no-raw-otel-primitives` lint. This trades registry coverage for adopting an
  upstream feature as-is.
- **T04 One added runtime dependency:** The shared sdkPath pulls an
  `@opentelemetry` OTLP/HTTP exporter into the test-support package, and adding
  it triggers a one-time nix FOD-hash refresh across workspace CLIs. This trades
  a dependency + a mechanical refresh for a faithful standard exporter.
- **T05 Built on an experimental feature:** `experimental.openTelemetry` may
  change across Vitest versions. The Effect-native lane stays load-bearing so a
  breaking change degrades observability, not product-span capture.

## Requirements

### Runner coverage is default-on under a collector

- **R01 Collector-gated enablement:** Native Vitest OTEL is enabled when a
  collector/trace context is present (a dedicated environment switch the devenv
  test task sets), and disabled otherwise. Enablement is not tied to a debug
  flag.
- **R02 Zero per-package config:** Enablement lives in one shared place (the
  root Vitest config + one shared sdkPath module); no package's
  `vitest.config.ts` changes.
- **R03 Runner tree under the task trace:** With native OTEL on, the run emits
  the Vitest runner-span tree (worker → runtime → runner → per-test callback)
  to the configured OTLP endpoint, rooted under the ambient task `TRACEPARENT`.
- **R04 Minimal instrumentation:** The sdkPath installs no auto-instrumentations
  (no fs/http/etc. hooks inside the test process); it emits only Vitest's own
  runner spans.
- **R05 Single disable switch:** The entire mechanism is disabled by one
  environment switch, for the rare suite where the per-file cost is unwanted.

### Product spans nest under the runner, explicitly

- **R06 Explicit parent seed:** When the harness exports product spans and a
  runner span is active, the harness seeds that runner span as the explicit
  Effect parent of the test's root span, so product spans share the run's trace.
- **R07 Per-test resolution:** The active runner span is read at test-execution
  time, resolving the current test's callback span — never a per-file value
  captured when the layer is built.
- **R08 No global-provider dependency for the harness tracer:** Nesting does not
  require routing the harness `OtlpTracer` through the global tracer provider;
  the harness tracer stays independent (T01).
- **R09 Inert when idle:** When native OTEL is off (no active runner span) the
  seed is a no-op, leaving harness behavior unchanged.

### The assertion lane stays deterministic

- **R10 Capture-lane suppression:** When the otelite in-process capture is
  active for a test, the runner-parent seed is suppressed, so captured product
  spans stay inside the capture-owned trace and their shape is independent of
  whether native Vitest OTEL is enabled for the run.
- **R11 Suppression is structural, not per-test:** Suppression is provided by
  the capture layer itself, requiring no change to individual assertion tests.
- **R12 No capture pollution:** Runner spans export to the configured collector,
  never into the in-process otelite receiver used for assertions.

### Cost and governance are explicit

- **R13 Bounded per-file overhead:** Native OTEL adds only a small, bounded
  per-file cost (SDK init + batched export); it must not depend on
  auto-instrumentation and should be reducible via batching.
- **R14 Ungoverned names are declared:** `vitest.*` runner span names are
  explicitly recorded as external/ungoverned, so their absence from the
  telemetry registry is intentional, not an oversight (T03).

### Run outcomes and export completion stay trustworthy

- **R15 Failure status:** A failed test preserves the Vitest process failure and
  marks the corresponding native callback span as an OpenTelemetry error.
- **R16 Bounded drain:** Success and failure runs drain pending runner and
  product telemetry within their configured teardown bounds; an unavailable
  receiver cannot turn telemetry teardown into an unbounded test run.
- **R17 OTLP interoperability:** A standards-conforming OTLP receiver accepts
  both native runner and Effect product telemetry without rejected records, and
  the decoded records preserve the collector gate, ambient task parenting,
  Vitest-to-Effect parent bridge, assertion-lane suppression, successful drain,
  and failed-callback status.
