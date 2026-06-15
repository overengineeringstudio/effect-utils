# GC runs in bounded memory AND good throughput, proven by OTEL

## Status

proposed (operating point to be fixed experimentally)

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
   Verified end-to-end via gcx/Tempo (traces) + gcx/Prometheus (RSS), on isolated
   stores scaled to mirror the real fleet.

## Consequences

- The fix is implementation + instrumentation only; the gc POLICY (decisions
  0001–0006: gates, staleness, lossless floor, timers, default-gc) is unchanged.
  The lossless floor's dirt signal (0003) stays correct — dirt travels with the
  `git worktree move`, so only a bounded `isDirty`+count is needed, never the list.
- A regression test asserts the memory bound (a worktree with a large untracked
  tree must not raise peak RSS beyond a small constant).
- The concrete concurrency/batch numbers land here once the OTEL sweep fixes them.
