# Shutdown-flush contract: fast CLI exit and reliable OTel flush

## Status

accepted

## Context

A CLI entered through `runTuiMain` has two competing goals at shutdown:

- **Reliable telemetry flush** — the final spans/metrics/logs must reach the
  collector, even when the collector is slow.
- **Fast shutdown** — natural exit and Ctrl-C must return as quickly as
  possible; a CLI must never feel like it hangs on exit.

The OTLP flush is a single Effect scope finalizer (`@effect/opentelemetry`'s
exporter registers it) wrapped in `Effect.interruptible` +
`Effect.timeoutOption(shutdownTimeout)`. Effect's scope semantics **await that
finalizer to completion** on natural exit, so no fixed wait is required for
correctness. The failure mode was misusing `shutdownTimeout` as a tuning knob:
`mr.ts` set it to `50ms`, shorter than one collector round-trip, so the timeout
interrupted the in-flight export and `Effect.ignore` silently dropped the final
batch ("the gauge sometimes didn't land"). Separately, `NodeRuntime.runMain`'s
default teardown forces exit code 0 on a signal, clobbering the conventional
`130`, so a Ctrl-C'd CLI wrongly reported success to the shell.

## Decision

1. **No fixed wait on the happy path.** The flush finalizer is awaited to
   completion; exit happens as soon as it finishes (≈ one round-trip). Nothing
   in `runTuiMain` / `NodeRuntime.runMain` adds a fixed teardown delay.
2. **`shutdownTimeout` is a ceiling, never a floor.** It bounds only the worst
   case (a black-holed collector) and costs nothing when the collector is
   healthy. Default is TTY-aware — **30s** non-interactive (CI), **10s**
   interactive — and CLIs must not set a small per-CLI override. Export
   intervals are mid-run granularity only; the scope-close finalizer delivers
   the final batch regardless.
3. **Ctrl-C bails fast.** The finalizer stays `Effect.interruptible`, so a
   signal during a slow/dead-collector flush escapes the cap in milliseconds.
4. **Signal → exit 130.** `runTuiMain` passes a custom `teardown` that honors
   the `process.exitCode = 130` its interrupt branch sets (instead of the
   default's hardcoded 0); uncaught failures map to 1, success to 0.

## Consequences

- Healthy collector: the cap is never reached; 10s vs 30s is invisible.
- Black-holed collector: worst-case natural-exit latency is the cap, and only
  then — Ctrl-C escapes it in milliseconds.
- **Known residual (out of scope):** a transient _mid-run_ export failure trips
  the exporter's 60s self-disable, after which the final flush short-circuits
  regardless of the cap. Tracked separately; not solvable via `shutdownTimeout`.

Verified by `test/integration/cli-shutdown-flush.test.ts` (natural exit awaits +
lands the flush and is fast; signal → 130 and bails fast; success → 0) and, for
the real OTLP exporter flush, the `@overeng/utils` / `@overeng/megarepo` otel
tests.
