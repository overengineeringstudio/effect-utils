# 0002 - Product-span export stays per-test + independent; raise the flush timeout

Status: accepted

## Context

Native runner spans (`vitest.*`) reach a collector reliably because Vitest owns
their SDK and awaits one `sdk.shutdown()` per worker. The Effect **product**
spans (the code-under-test's own `@overeng/l` instrumentation, exported through
the harness `OtlpTracer` in `makeOtelVitestLayer`) do **not** — a real dev3 run
produced the full runner tree but zero product spans (finding "F4").

The question: how should the harness export product spans so they reach a
collector reliably, without blocking fast tests, and without giving up the
explicit boundaries decision [0001](./0001-two-lane-explicit-bridge.md) protects.
Four designs were considered: **(a)** per-test own exporter (status quo);
**(b)** route product spans through Vitest's global SDK provider; **(c)** a
worker-scoped own exporter with an awaited teardown flush; **(d)** a
`sdkPath`-owned worker-scoped exporter.

## Evidence and Argument

### Root cause (source, `@effect/opentelemetry@0.63.0`)

`internal/otlpExporter.js:60` — the scope-close flush is
`runExport.pipe(Effect.ignore, Effect.interruptible, Effect.timeoutOption(shutdownTimeout))`.
On a fast test the periodic interval (`OtlpTracer.js:28`) never ticks, so every
product span depends on that one finalizer flush. Its budget is
`shutdownTimeout` (default **3s**, `OtlpTracer.js:42`); when the collector's
round-trip exceeds it, the flush is **interrupted mid-POST and the loss is
swallowed by `Effect.ignore`**. The native runner SDK survives identical latency
because it uses a 10s timeout. Confirmed by a latency-injecting proxy: RTT=0 →
delivers; RTT=4s → dropped (exact F4 signature).

### Benchmark (reproducible harness, 17 measured cells)

Product spans = 2/test; RTT = injected per-flush collector delay.

| regime              | (a) per-test own             | (c/d) worker-scoped                        | (b) global provider                                      |
| ------------------- | ---------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| local (RTT≈0)       | 100%, ~1–2 ms/test           | 100%, 1 flush, ~5× less wall               | 100% but **nest 0%, svc=`vitest-runner`, N root traces** |
| slow (RTT>3s)       | 0% (interrupt), blocks N×RTT | 0% **all-or-nothing** (loses whole worker) | —                                                        |
| failure granularity | per-**test**                 | per-**worker**                             | —                                                        |

- The devenv default points product export at a **local** collector
  (`nix/devenv-modules/otel.nix:414`); only `OTEL_MODE=system` points remote. So
  the common case is RTT≈0, where **(a) delivers 100% at ~1–2 ms/test**.
- **(c) is only implementable as (d).** The only worker-scoped, Vitest-_awaited_
  flush seam is the `sdkPath` module's `shutdown()` (`init.d4hAcNdp.js:220,348`);
  `setupFiles` `afterAll` is per-file, `globalSetup` teardown is main-process. A
  worker-scoped own exporter would therefore be a worker-global singleton whose
  single teardown POST carries **all** delivery risk (measured 0% at RTT=5s — one
  slow flush loses the entire worker's spans, vs (a) losing one test's).
- **(b) is measurably wrong:** product spans inherit `service.name=vitest-runner`
  and become N distinct root traces (nesting lost) — the `context.active()` /
  resource cost, measured. It also violates 0001 R08/T01.

### Argument

Locally (the default), (a) already delivers 100% cheaply, keeps every explicit
boundary (own exporter, own `service.name`, no global singleton, otelite lane
isolated by the suppression marker), and fails per-test rather than per-worker.
Its only defect is the 3s silent-drop under a slow collector — fixed by raising
`shutdownTimeout` above the native 10s. The fix has zero cost when the collector
is fast (the flush blocks only for the actual ack). (d)'s single-batched-flush
advantage is real only for a remote high-volume regime, and it trades per-test
for per-worker blast radius plus a worker-global singleton.

## Decision

- **Keep (a)** — the per-test, independent `OtlpTracer` — and set
  `shutdownTimeout` default to **15s** in `makeOtelVitestLayer` (shipped).
- **Reject (b)** (misattribution + nesting loss + 0001 violation).
- **(d) is a regime-conditional escalation**, adopted only if a real
  remote-collector, high-volume export need appears where (a)'s per-test blocking
  (wall ≈ N×RTT) becomes a suite-time cost — see DQ4.
- The otelite assertion lane is unchanged (own in-process receiver via
  `SuppressVitestParentBridge`).

## Consequences / sharp edges

- Under a genuinely slow collector, (a) still blocks each test for its flush
  (bounded by 15s) — acceptable locally, a suite-time cost remotely (DQ4).
- The 250ms `exportInterval` has a latent drop race for tests longer than the
  interval (a periodic export in-flight at scope close is interrupted). Fast
  tests never hit it; documented as DQ5.
- Silent loss on exporter failure persists (`Effect.ignore` + 60s self-disable);
  a slow/erroring collector still burns the timeout budget on retries.
