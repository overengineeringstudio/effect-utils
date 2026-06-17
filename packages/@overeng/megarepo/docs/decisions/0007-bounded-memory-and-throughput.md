# GC runs in bounded memory with measured throughput

## Status

accepted; `MEGAREPO_GC_REPO_CONCURRENCY` default 4

## Decision

`mr store gc` and `mr store status` must not materialize large git output or
progressively copy result arrays. Large subprocess output is streamed or parsed
incrementally; dirt is a bounded signal/count, never a full untracked-file list;
per-repo work is process-and-discard.

Repo concurrency is bounded and tuned by measurement. The accepted default is 4,
the observed throughput knee. OTEL verifies the operating point with phase spans,
`git.output.bytes`, and `megarepo_store_gc_rss_bytes`.

Policy decision [0001](0001-reclaim-cold-worktrees-in-default-gc.md) is
unchanged. Telemetry tests use explicit OTLP endpoints and wall-time sampling so
fixed decision clocks cannot hot-loop sampler/exporter schedules.
