This document specifies how vitest-otel emits Vitest runner telemetry and nests
Effect product spans under it. It builds on [requirements.md](./requirements.md).

## Status

Implemented by the shared test module, root Vitest config, and
`@overeng/utils-dev` bridge. The original behavior was validated end-to-end in
an isolated prototype (see
[.experiments/prototype-validation.md](./.experiments/prototype-validation.md)).

## Scope

Defines:

- The shared Vitest `sdkPath` module and how native OTEL is enabled (R01–R05).
- The Vitest→Effect parent bridge and its placement in `withTestCtx` (R06–R09).
- Capture-lane suppression (R10–R12).
- Independent runner/product teardown budgets (decision
  [0003](./.decisions/0003-product-span-flush-budget.md)).

Does not define:

- The Effect-native `OtlpTracer` / `makeOtelVitestLayer` export path — see
  `@overeng/utils-dev` `node-vitest`.
- The otelite receiver / assertion API — see `@overeng/utils-dev` `otelite`.
- The observability backend lifecycle, endpoint, or `TRACEPARENT` injection —
  see `devenvModules.observability` and its otelite profiles.

## Two lanes

The system distinguishes two lanes by _purpose_, not by debug-vs-not. The
distinction that matters is determinism.

| Lane                 | Question                                       | Native runner OTEL | Parent bridge                 | Export target               |
| -------------------- | ---------------------------------------------- | ------------------ | ----------------------------- | --------------------------- |
| Observability export | "why is this test slow / what did the run do?" | on (R01)           | on when harness exports (R06) | configured collector        |
| otelite assertion    | "did my code emit the right telemetry?"        | on (harmless)      | **suppressed** (R10)          | in-process otelite receiver |

Runner spans always go to the collector, never into the otelite receiver
(R12); the two exporters are independent providers.

## Enablement (R01–R05)

```
root vitest.config.ts
  test.experimental.openTelemetry = VITEST_OTEL_RUNNER=1
    ? { enabled: true, sdkPath: utils-dev/node-vitest/otel-sdk.mjs }
    : (absent)
```

- `VITEST_OTEL_RUNNER` is the collector-context switch (R01, R03). A consumer
  opts its shared test module into root-workspace execution with
  `vitestWorkspaceRoot`; those tasks set the switch when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is configured. Package-local tasks, bare local
  runs, and watch runs leave it unset → native OTEL absent (A03). It is also the
  single disable switch (R05).
- Enablement is global config, applied to every opted-in project run with no
  per-package config edit (R02). Package-local execution remains the reusable
  module's default (decision
  [0002](./.decisions/0002-default-safe-root-workspace.md)).

### sdkPath module (R04)

`packages/@overeng/utils-dev/src/node-vitest/otel-sdk.mjs`:

```js
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

const provider = new NodeTracerProvider({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
})
provider.register() // installs global provider + AsyncLocalStorage ctx (A01, A02)
export default provider // Vitest calls .shutdown() to flush
```

- No `getNodeAutoInstrumentations()` — the process is not instrumented (R04).
- `.mjs`, loaded by Vitest outside the TS transform pipeline.
- The exporter honors standard `OTEL_EXPORTER_OTLP_ENDPOINT` env; runner spans
  root under the ambient `TRACEPARENT` (R03).

Emitted tree (observed): `vitest.worker → vitest.runtime.run →
vitest.test.runner.run.{module,spec,test} → vitest.test.runner.test.callback`,
plus `vitest.module.transform`, `vitest.test.runner.collect_spec`, coverage,
and `beforeEach`/`afterEach` spans.

## The parent bridge (R06–R09)

Because `OtlpTracer` parents only from the Effect-level parent (A04), nesting is
explicit: read the active runner span once and seed it as the Effect parent.

```
run test callback  ── Vitest sets vitest.test.runner.test.callback active ──┐
                                                                            │ trace.getActiveSpan()
withTestCtx(self):                                                          ▼
  bridgeVitestParent(                                    Effect.withParentSpan(
    self.pipe(timeout, provide(combinedLayer), scoped)      makeExternalSpan(spanContext))
  )                                                    ── seeds harness root span's parent ──▶
                                                          OtlpTracer inherits traceId + parentSpanId
```

```ts
const bridgeVitestParent = (self) =>
  Effect.suspend(() => {
    // read at exec time (R07)
    const sc = trace.getActiveSpan()?.spanContext()
    if (sc === undefined) return self // native OTEL off → no-op (R09)
    return Effect.serviceOption(SuppressVitestParentBridge).pipe(
      Effect.flatMap((s) =>
        Option.isSome(s) // capture lane → suppress (R10)
          ? self
          : Effect.withParentSpan(self, OtelTracer.makeExternalSpan(sc)),
      ),
    )
  })
```

- Applied **outermost** in `withTestCtx` so the harness root span
  (`Layer.span(rootSpanName)`) is created under the seeded parent; the whole
  product subtree then inherits the run's `traceId` (validated: product spans
  carry Vitest's exact traceId).
- The harness `OtlpTracer` is never routed through the global provider (R08,
  T01); only the read of `getActiveSpan()` touches the global context — an
  inherent, single, synchronous seam at test entry.

## Suppression (R10–R12)

```
makeOteliteCaptureLayer()
  = exporterLayer                                   (product spans → otelite receiver)
    ⊕ Layer.succeed(SuppressVitestParentBridge, true)   (marker in test context)
```

- The marker tag `SuppressVitestParentBridge` is defined in `node-vitest`
  (lower layer) and provided by the otelite capture layer (upper layer) — no
  circular dependency, no per-test change (R11).
- `bridgeVitestParent` checks it via `Effect.serviceOption`; when present the
  seed is skipped and captured product spans stay root (R10).

## Design questions

- **DQ1 — Should product export ever be default-on under devenv/CI?** Current
  spec keeps per-test product export opt-in (T02) on trace-volume grounds.
  Resolving this needs a measured volume/value assessment on a representative
  CI run.
- **DQ2 — The `Layer.span` root span does not reach the exporter.** In the
  export lane the harness's own per-test root span (`makeOtelVitestLayer`'s
  `Layer.span(rootSpanName)`) was not observed in the exported spans, though the
  product spans under it nest correctly. Likely a tracer-init ordering nuance in
  `makeOtelVitestLayer`. Orthogonal to nesting; resolving it would make the
  per-test root span itself visible in the collector.
- **DQ3 — sdkPath as `.ts` vs `.mjs`.** `.mjs` sidesteps Vitest's TS-transform
  caveat for sdkPath modules; whether a typed `.ts` sdkPath is worth the setup
  is open.
