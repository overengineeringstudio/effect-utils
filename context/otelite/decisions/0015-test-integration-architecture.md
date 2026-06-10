# Test-integration architecture: in-process capture in `@overeng/utils-dev`

How otelite is consumed for telemetry assertions in tests, in three layers: D1
child-based wire round-trip (shipped), D2 in-process synthetic capture, D3
real-consumer span assertions. The typed wrapper and the vitest bridge live in
`@overeng/utils-dev` (the `./otelite` subpath); each consumer owns its own
real-span tests.

## Packaging: merge the wrapper into `@overeng/utils-dev`

The Effect wrapper (formerly the standalone `@overeng/otelite-effect`) folds into
`@overeng/utils-dev` as a `./otelite` subpath export, co-located with the vitest
OTEL test layer it integrates with. Evidence: no non-test consumer of the wrapper
exists; `utils-dev` already declares every dep it needs (`@effect/platform`,
`@effect/platform-node`, `@effect/opentelemetry`, `@effect/vitest`); `utils-dev`
already uses subpath exports and binary-on-PATH test deps (playwright). The
wrapper is conceptually a dev/test utility, so `utils-dev` is its correct home —
not merely a way to dodge the `utils-dev ⇄ otelite-effect` cycle that putting the
bridge in `utils-dev` while keeping the wrapper separate would create. Revises
0007's "a second package joins" consequence and R09/T04. Re-extract to a
standalone package only if a non-test (runtime) consumer appears — same logic as
T03.

## In-process capture primitive (D2)

A scoped `capture` on the `Otelite` service boots `otelite capture`, reads the
`otelite.endpoints/v1` event (no scraping), yields the endpoints to the *test
process* for in-process emission, stops by closing stdin (EOF), drains the
`otelite.summary/v1`, and inspects the out-dir as typed rows. The vitest bridge
wires this into the existing OTEL test layer (which points its OTLP exporter at
the captured endpoint). Built on the 0014 contract; no stderr scraping, no SIGINT.

## Receiver lifecycle: per-file default

Measured (suites to 2000 tests, vitest forks pool, 32 cores): per-file is
~40–65× cheaper than per-test in lifecycle CPU (50 spawns vs 2000) with no
isolation loss and zero cross-talk over 8000+ assertions; per-test / per-file /
per-worker share the same flat FD/port profile (peak concurrent receivers =
worker count, ~14 FDs each). Default **per-file**; **per-test** opt-in for small
suites that want zero disambiguation logic (~12 ms/test spawn tax); **per-worker**
only for massive suites that accept `isolate:false` + a *process-level* teardown
(under vitest's default `isolate:true` it silently degrades to per-file, and a
file-level teardown breaks every test after the first). per-suite/global is
infeasible — an in-process receiver cannot cross forked workers.

## Read-after-write visibility (cross-cutting)

Under heavy CPU oversubscription an independent `inspect` reader can transiently
see 0 rows although the span is already durably written (write-before-ack);
recovered by a ~2 ms retry, and 0 failures single-threaded. So the capture/assert
helper does a **bounded short-poll retry** (~tens of ms). Follow-up: confirm the
sink flushes per line so live mid-capture reads are coherent without leaning on
the retry (the more principled fix). Capture itself never lost a span in any run.

## D3 coupling: consumer-owned, one demonstrator

Real-consumer span-assertion tests live in the **consumer's** suite (importing the
`utils-dev/otelite` capture helper), not otelite's — so churn-coupled assertions
sit next to the instrumentation that churns, and `utils-dev` stays lean (ships the
primitive, not the fixtures). Ship one demonstrator (an instrumented HTTP/
pagination path) to lock the helper against a real path; keep assertions to
structure + a few stable attrs, including that secrets are `<redacted>` in the
capture (doubles as a leak guard for this public repo).

## Independent: `OtlpTracer` URL bug

`@effect/opentelemetry`'s `OtlpTracer.layer({ url })` POSTs to `url` verbatim (no
`/v1/traces` suffix, unlike the logger/metrics layers), so the existing
`makeOtelVitestLayer` trace wiring 404s silently and the exporter self-disables.
Fix as its own small change to the shared `utils-dev` test layer, independent of
the otelite work (coordinate — shared file).

## Status

Design accepted (grilled). D1 shipped (R09/R03 path). D2/D3 + the package merge
are pending implementation.
