# GC runs in bounded memory AND good throughput, proven by OTEL

## Status

accepted (operating point fixed by the OTEL sweep: `MEGAREPO_GC_REPO_CONCURRENCY` default **4**)

## Context

`mr store gc` (and `mr store status`) OOM-killed the host on the real store. Root
cause (confirmed empirically, `tmp/gc-oom/`): `runGitCommand` collects subprocess
output with a per-chunk `Uint8Array` `reduce` that is O(n²) in output size; the
trigger is `git status --porcelain --untracked-files=all` on a worktree with a
large untracked tree (10.3 MB / 64k files → 269 MB peak; 80 MB → OOM at an 8 GB
cap). A single-allocation O(n) join drops that to 10 MB (27×). OTEL was refuted as
a cause (no endpoint ⇒ `Layer.empty`). The same `getWorktreeStatus` runs under
64-way concurrency in `mr store status` — fan-out × the same bug ≈ 17 GB.

Bounding memory alone is not enough: the cold path is serial (`concurrency=1`),
which is memory-safe but network-bottlenecked (≈31 repos × fetch + `gh`,
sequentially). Streaming makes per-operation memory small, which is what permits
raising concurrency for throughput without re-OOMing.

## Decision

The gc/status memory–throughput operating point is a deliberate, measured choice,
not an accident:

1. **Bounded memory.** Peak RSS is independent of store size, worktree count, and
   per-worktree untracked-tree size. Subprocess output is streamed/parsed
   incrementally (`Command.streamLines` for large parsers; never the O(n²) concat),
   the dirt check never materializes the full untracked tree, and per-repo work is
   process-and-discard (no materialize-once-consume-twice, no `results:[...results]`
   progressive copies).
2. **Throughput.** Concurrency (primarily across repos, network-bound) is raised
   to the point where wall-clock stops improving or RSS starts climbing — whichever
   comes first. Back-pressure is structural (bounded `Stream`/`Effect.all`
   concurrency), not a fixed serial bottleneck.
3. **Proven by OTEL, not asserted.** The chosen operating point is justified by
   data: an RSS gauge (`megarepo_store_gc_rss_bytes`, ephemeral-gauge) stays flat
   across a parameter sweep, and per-phase span durations show the throughput gain.
   Verified end-to-end via OTEL queries (Tempo traces + Prometheus-compatible
   metrics), on isolated stores scaled to mirror real-world layouts.

## Consequences

- The fix is implementation + instrumentation only; the gc POLICY (decisions
  0001–0006: gates, staleness, lossless floor, timers, default-gc) is unchanged.
  The lossless floor's dirt signal (0003) stays correct — dirt travels with the
  `git worktree move`, so only a bounded `isDirty`+count is needed, never the list.
- A regression test asserts the memory bound (a worktree with a large untracked
  tree must not raise peak RSS beyond a small constant).
- **Operating point (from the OTEL sweep, `tmp/gc-oom/sweep-findings.md`):**
  `MEGAREPO_GC_REPO_CONCURRENCY` default **4**. On a 1200-worktree isolated store
  (4 with ~30k-file untracked trees) with a 300 ms/call `gh` latency shim, wall
  time was 25.2 s → 11.4 s (2.2×) from concurrency 1 → 4; 4 → 8 added only ~7% and
  8 → 32 sat at the run-to-run noise floor. Peak process-tree RSS stayed ~537 →
  633 MB (≈18% over a 32× concurrency increase, all sub-GB) — memory does not bind,
  it only confirms raising concurrency is safe. Throughput is the binding
  constraint, and its knee is 4.
- Proven via OTEL: the six `megarepo/store/gc/*` phase spans + `git/cmd` land in
  Tempo (`service.name=megarepo`) and the `megarepo_store_gc_rss_bytes` gauge in a
  Prometheus-compatible store. The exporter's `metricsExportInterval` must be small enough that the gauge
  flushes within a short run (the default 10 s undersamples ~10 s runs — the
  trustworthy memory curve came from a 100 ms external process-tree sampler).
- Instrumentation must be testable, not disabled: a dedicated otelite-capture test
  (`src/cli/store-gc-otel.integration.test.ts`) stands up an ephemeral OTLP
  receiver, runs the gc in-process through the real exporter, and asserts the six
  phase spans, a `git/cmd` span carrying `git.output.bytes`, and the
  `megarepo_store_gc_rss_bytes` gauge (value > 0, `repo_concurrency` label) all
  land.
- **Instrumentation samples on real wall-time, decoupled from the gc's decision
  clock.** The RSS-sampler fiber refreshes the gauge at periodic intervals; coupling
  its cadence to the decision clock was the latent defect (a zero-sleep clock turns
  `Schedule.spaced` into a hot loop). The sampler is wrapped in
  `Effect.withClock(Clock.make())` so it ticks on wall time regardless of the
  ambient clock. The bulk verdict tests stay hermetic w.r.t. OTLP (the setupFile
  unsets `OTEL_EXPORTER_OTLP_ENDPOINT` so they never POST to a dev collector);
  telemetry-asserting tests opt back in with their own ephemeral receiver and a
  fixed DECISION clock whose `sleep` delegates to a live clock (so the exporter's
  reader fibers tick on wall time too). The sampler is gated on the endpoint being
  set, so it is zero-overhead when OTLP is off.
