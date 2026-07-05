This document specifies how vitest-otel emits Vitest runner telemetry and nests
Effect product spans under it. It builds on [requirements.md](./requirements.md).

## Status

Draft. Validated end-to-end in an isolated prototype (see
[.experiments/prototype-validation.md](./.experiments/prototype-validation.md));
not yet landed on the mainline harness.

## Scope

Defines:

- The shared Vitest `sdkPath` module and how native OTEL is enabled (R01–R05).
- The Vitest→Effect parent bridge and its placement in `withTestCtx` (R06–R09).
- Capture-lane suppression (R10–R12).

Does not define:

- The Effect-native `OtlpTracer` / `makeOtelVitestLayer` export path — see
  `@overeng/utils-dev` `node-vitest`.
- The otelite receiver / assertion API — see `@overeng/utils-dev` `otelite`.
- The devenv OTEL collector, endpoint, or `TRACEPARENT` injection — see
  `nix/devenv-modules/otel.nix`.

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

- `VITEST_OTEL_RUNNER` is the collector-context switch (R01, R03); the devenv
  test task sets it when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured. Bare local
  and watch runs leave it unset → native OTEL absent (A03). It is also the
  single disable switch (R05).
- Enablement is global config, applied to every project run with no per-package
  edit (R02).

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

## Product-span export reliability

Product spans use the per-test, independent `OtlpTracer` (own `service.name`,
own target, isolated from the otelite lane). On a fast test the only flush is the
scope-close finalizer, bounded by `shutdownTimeout`; the `@effect/opentelemetry`
default (3s) silently drops spans mid-POST under a slow collector while the
native runner SDK (10s) survives. The harness raises `shutdownTimeout` to 15s so
both lanes tolerate the same round-trip. The full a/b/c/d design study, source
root cause, and benchmark are in
[.decisions/0002-product-span-export-reliability.md](./.decisions/0002-product-span-export-reliability.md);
routing product spans through the global provider (option b) is rejected there
(misattribution + nesting loss + violates R08/T01).

## Design questions

- **DQ1 — Should product export be default-on under devenv/CI?** Product export
  is reliable and cheap against the _local_ collector (~1–2 ms/test, 100%
  delivery — see 0002), so the constraint is remote-collector trace **volume**,
  not local viability. Resolving this needs a measured volume/value +
  tail-sampling assessment on a representative remote CI run.
- **DQ2 — The `Layer.span` root span does not reach the exporter.** The harness's
  own per-test root span (`makeOtelVitestLayer`'s `Layer.span(rootSpanName)`) is
  not observed in the exported spans, though product spans under it share the run
  traceId. Likely a tracer-init ordering nuance; orthogonal to nesting.
- **DQ3 — sdkPath as `.ts` vs `.mjs`.** `.mjs` sidesteps Vitest's TS-transform
  caveat for sdkPath modules; whether a typed `.ts` sdkPath is worth the setup
  is open.
- **DQ4 — When (if ever) to adopt option (d)?** A `sdkPath`-owned, worker-scoped
  exporter gives one batched teardown flush (no per-test blocking) but trades
  per-test for per-worker delivery blast radius plus a worker-global singleton
  (0002). Warranted only if a remote-collector, high-volume regime makes (a)'s
  per-test blocking (wall ≈ N×RTT) a real suite-time cost.
- **DQ5 — The 250ms `exportInterval` drop race.** For a test longer than the
  interval, a periodic export in-flight at scope close is interrupted and those
  spans are lost. Fast tests never hit it; a larger `exportInterval` (past any
  test duration) would close it at the cost of buffering until scope close.
