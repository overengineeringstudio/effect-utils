# 0001 - Two lanes, explicit bridge, runner-default / product-opt-in

Status: accepted

## Context

Vitest 4.x ships an experimental native OpenTelemetry integration
(`test.experimental.openTelemetry`). Our tests already run under a traced
devenv/CI task, but the test run itself is an opaque span. Separately, our test
harness can export product spans through `@effect/opentelemetry` and can capture
them in-process (otelite) for deterministic assertions.

The question is how to adopt native Vitest OTEL across the megarepo in a way
that closes the visibility gap without breaking the assertion lane or forcing
per-package config. Three sub-decisions were load-bearing.

## Evidence and Argument

### Explicit bridge, not global-context parenting

The harness tracer is `@effect/opentelemetry`'s lightweight `OtlpTracer`, which
imports only `effect/*` — no `@opentelemetry/api`. Reading its source, it
parents a span _solely_ from the Effect-level parent
(`self.traceId = self.parent.value.traceId`); it never consults the global
`context.active()`. So Effect spans do **not** auto-nest under Vitest's active
runner span.

The api-based `Tracer.layerGlobal` _does_ auto-parent from the global context,
but using it would route our spans through the global provider — the "global
patching" path we want to avoid. Instead we read `trace.getActiveSpan()` once at
test entry and seed it as an explicit Effect parent via
`Effect.withParentSpan(makeExternalSpan(sc))`. The harness tracer stays an
independent, non-global provider.

Validated: with the explicit seed, product spans carry Vitest's byte-identical
`traceId` — a match impossible by chance, proving the bridge connects the trees.
See [.experiments/prototype-validation.md](../.experiments/prototype-validation.md).

### The two lanes are separated by determinism, not by "debug"

The otelite assertion lane captures product spans and asserts over their shape.
If the bridge fired during those tests, captured spans would gain a runner
parent and a foreign traceId — breaking any root-ness assertion and making
captured shape depend on whether native OTEL happened to be on. So the assertion
lane must opt out.

Task-level separation is not available: assertion tests are ordinary unit tests
in the main suite. Instead the otelite capture layer provides a
`SuppressVitestParentBridge` marker (defined in the lower `node-vitest` layer,
provided by the upper otelite layer — no circular dependency), and the bridge
skips the seed when it is present. Validated: otelite tests pass 4/4 with native
OTEL genuinely active (157 runner spans emitted the same run).

### Runner coverage default-on, product export opt-in

Runner spans are ~dozens of low-volume structural-timing spans per file and
directly close Problem 1; they export by default whenever a collector context
is present (the `VITEST_OTEL_RUNNER` switch the devenv task sets), not behind a
debug flag. Per-test product spans are high-volume; exporting them for every
test on every CI run is a large trace volume for little routine value, so they
remain opt-in (harness `forceOtel` / targeted investigation). Measured runner
overhead was a small bounded per-file cost with a minimal (no-auto-instrument)
SDK.

## Consequences

- One shared sdkPath + root-config gate; no per-package `vitest.config.ts`
  change.
- The harness gains a `SuppressVitestParentBridge` tag and a `bridgeVitestParent`
  wrapper in `withTestCtx`; the otelite capture layer provides the marker.
- Adopting the standard OTLP exporter adds an `@opentelemetry` dependency to the
  test-support package and requires a one-time nix FOD-hash refresh across
  workspace CLIs (Evergreen `fod chase-fod-closure`).
- `vitest.*` runner span names are external/ungoverned by the telemetry
  registry — recorded intentionally, not an oversight.
- Native OTEL is experimental; the Effect-native lane stays load-bearing so a
  breaking upstream change degrades observability, not product-span capture.
