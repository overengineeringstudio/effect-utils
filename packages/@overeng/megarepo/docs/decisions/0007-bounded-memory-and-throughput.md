# GC runs in bounded memory with measured throughput

## Status

accepted (`MEGAREPO_GC_REPO_CONCURRENCY` default 4)

## Context

`mr store gc` and `mr store status` could OOM on large stores. The root cause was
subprocess output collection that grew superlinearly on large `git status
--porcelain --untracked-files=all` output, amplified by high fan-out. Once output
is streamed or joined in one allocation, concurrency can be raised for network
throughput without reintroducing the memory failure.

## Decision

- Peak RSS must be bounded with respect to store size, worktree count, and
  untracked-tree size.
- Large git output is streamed or parsed incrementally; the dirt check records a
  bounded dirty signal and count, never the full file list.
- Per-repo work is process-and-discard; no progressive result copying.
- GC uses bounded repo concurrency. The measured knee is 4, so that is the
  default.
- The operating point is verified with OTEL: phase spans, `git.output.bytes`, and
  `megarepo_store_gc_rss_bytes`.

## Consequences

- Policy decisions 0001-0006 are unchanged; this decision constrains the
  implementation and instrumentation.
- A regression test covers large untracked trees without proportional RSS growth.
- Telemetry tests use an explicit OTLP endpoint and wall-time RSS sampling so a
  fixed decision clock cannot turn sampler/exporter schedules into hot loops.
- Library and command code receive OTLP configuration from the composition root;
  they do not read ambient environment directly.
