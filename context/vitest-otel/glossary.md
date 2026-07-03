# Glossary: vitest-otel

**Runner span.** A span emitted by Vitest's own native OpenTelemetry
integration describing runner mechanics — `vitest.worker`, `vitest.module.*`,
`vitest.test.runner.run.*`, `vitest.test.runner.test.callback`. Ungoverned
external name (not in the telemetry registry).

**Product span.** A span emitted by the code under test through
`@effect/opentelemetry` (`Effect.withSpan`), governed by the `otel-contract`
registry.

**sdkPath.** The module referenced by `test.experimental.openTelemetry.sdkPath`.
Vitest imports it once per worker; it constructs and `register()`s the
OpenTelemetry SDK and default-exports it so Vitest can flush on shutdown.

**Parent bridge.** The mechanism that seeds the active runner span as the
explicit Effect parent of a test's root span, so product spans nest under the
runner span. Implemented as `bridgeVitestParent` in `withTestCtx`.
_Avoid_: "global patching" (the bridge does not route the harness tracer
through the global provider — it only reads the active span).

**Suppression marker.** The `SuppressVitestParentBridge` context tag. Provided
by the otelite capture layer to disable the parent bridge for a test, keeping
captured product spans root and deterministic.

**Export lane.** The observability path: native runner OTEL on, product spans
optionally exported with the runner parent, sent to the configured collector.

**Assertion lane.** The otelite in-process capture path: product spans captured
by a local receiver and asserted over; the parent bridge is suppressed here.

**Collector context.** The condition — a configured OTLP endpoint and an
ambient `TRACEPARENT` — under which native runner OTEL is enabled (via the
`VITEST_OTEL_RUNNER` switch the devenv test task sets).
