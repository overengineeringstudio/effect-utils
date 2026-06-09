# Drain default: graceful in-flight, bounded idle opt-in, never unbounded

After the Child exits, otelite finishes serving already-accepted (in-flight)
exports, then closes — **no timer by default**. `--drain-idle <ms>` (bounded)
is the opt-in for fire-and-forget emitters. otelite never waits unbounded.

## Evidence (N=50/cell, loopback; `tmp/otelite-compare/drain/`)

| regime | close-immediate | in-flight | idle:200 |
| --- | --- | --- | --- |
| sync (awaits response) | 0% drop | 0% drop | 0% |
| SDK `shutdown()` | 0% drop | 0% drop | 0% |
| fire-and-forget | 100% | 100% | 0% |
| SDK no-shutdown | 0 spans (never sent) | 0 spans | 0 spans |

- In-flight drain = **0ms tax, 100% capture** for emitters that await their
  export on shutdown — the regimes otelite optimizes for (an un-awaited span is
  semantically a SUT flush failure, the real bug to surface).
- Fire-and-forget spans land **3–9 ms after child exit** (nothing in flight to
  drain — backgrounded curl hasn't finished its handshake). Only bounded
  idle-drain recovers them; the per-run tax ≈ the window.
- `no-shutdown` stays 0 under every strategy — idle-drain does **not** mask a
  SUT that never flushed. An **unbounded** wait would hang forever here: it
  can't distinguish "still coming" from "never sent."

## Framing for users

A dropped span under the default usually means the SUT exited without flushing
telemetry (the real bug). Reach for `--drain-idle` only for a knowingly
unfixable fire-and-forget emitter (e.g. the `otel-span` curl helper). CI tax
applies per run, so keep it explicit and tunable; 200ms cleared the tail
locally, containers need headroom.

## Collector-foundation note

If otelite is ever built on the collector instead, the analog is the `file`
exporter flush on SIGTERM — same principle (bounded, deterministic shutdown),
different mechanism. Drain semantics are foundation-independent.
