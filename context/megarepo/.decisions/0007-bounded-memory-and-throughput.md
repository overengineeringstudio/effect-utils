# GC runs in bounded memory with measured throughput

Status: accepted

Qualifier carried from the migrated record: `MEGAREPO_GC_REPO_CONCURRENCY`
default 4.

Migrated from `packages/@overeng/megarepo/docs/decisions` on 2026-08-31. The
Decision section is verbatim; the `Status:` line and the Context / Evidence and
Argument / Options sections were added to satisfy the VRS decision-record
shape, from this record's own material.

## Context

A store accumulates without bound, so any GC implementation that holds git
output or result arrays in memory degrades exactly as the store gets big enough
to need GC. The same applies to concurrency: an unbounded fan-out over repos
trades a memory problem for a process-and-IO problem.

## Evidence and Argument

The accepted repo-concurrency default of 4 is the observed throughput knee, not
a guess — and the operating point is verifiable after the fact from telemetry
(phase spans, `git.output.bytes`, `megarepo_store_gc_rss_bytes`) rather than
only at tuning time. Dirt is deliberately kept a bounded signal or count: the
full untracked-file list is the one output that scales with the worst-case
worktree.

## Options

This record predates the current decision-record shape and did not enumerate
options. The table below is reconstructed from the failure modes the record
names.

| Option                                        | Tradeoff                                                                 | Outcome  |
| --------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| Stream, discard per repo, bound concurrency at the measured knee (this record) | Bounded RSS at any store size; needs telemetry to keep the operating point honest | Accepted |
| Materialize git output and result arrays      | Simplest code; degrades exactly when the store is big enough to need gc    | Rejected |
| Unbounded repo concurrency                    | Best wall time on a small store; trades the memory bound for IO contention | Rejected |

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
