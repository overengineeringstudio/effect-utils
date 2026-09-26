# 0002 Seed One Trace per Pipeline Run Attempt

Status: accepted

Accepted 2026-09-26 (q42 and q46; q43 was a request for a bakeoff, not an independent acceptance).

## Context

Independent `devenv tasks run` invocations previously minted random task traces; a single CI run could not be opened as one trace. A seeded run trace makes the root and its child jobs addressable before the manifest exists. The initial proposal collided in its hash inputs, collapsed matrix jobs and retries, allowed competing root writers, and let an inherited `OTEL_TASK_TRACEPARENT` override the seed.

## Evidence and Argument

- The [sanitized bakeoff](../.experiments/2026-09-26-seeded-run-trace.md) rendered a 3-job, 15-command run as one 6,255-span trace; unseeded execution used 45 traces.
- Tempo retained duplicate roots with wrong bounds if every job wrote one; a late completed root repaired the orphan view. A local wrapper emitted a root on completion and INT/TERM; SIGKILL needs ingest reconstruction.
- The devenv executor replaces outgoing `TRACEPARENT`; otel-span currently prefers `OTEL_TASK_TRACEPARENT`. The corrected wrapper's isolated command microbenchmark measured ~76 ms overhead; full-task timings were too noisy to isolate it.

## Options

| Option | Tradeoff | Outcome |
| --- | --- | --- |
| One run-attempt trace with one root writer and dual propagation during devenv transition | Whole-run waterfall, requires bounded trace size and temporary legacy variable | Accepted |
| Per-job trace by default | Smaller traces but no single whole-run waterfall | Size fallback |
| Random per-task traces restitched after ingest | Multiple identities for each span, late correlation | Rejected |
| Seed task or `@completed` finalizer | No dependable end-of-run ownership; cancellation can skip finalizer | Rejected |

## Decision

Use `PIPELINE_RUN_ID` with distinct CI attempts or a local UUID. Derive trace/root/job ids from domain-separated, length-framed hashes with a nonzero guard. Matrix values qualify job keys. Each attempt root links to the previous attempt root. The local generic `devenv tasks run` entrypoint mints only if absent and writes the root at exit; the CI ingester owns its root after completion and synthesizes missing job spans. Replace an outer trace with bidirectional links rather than nesting it.

Clear inherited `OTEL_TASK_TRACEPARENT`, then seed both it and W3C `TRACEPARENT` to keep current devenv task instrumentation on the run trace. Fix devenv upstream to honor inbound W3C context and stop shell-hook overrides; delete the legacy task variable after that fix. INT/TERM gets a best-effort root, while kill/crash requires deterministic ingest reconstruction. See [spec](../spec.md) for the wire grammar and ownership sequence.

## Consequences

A single complete root may arrive after child spans; until then the index serves the run. The transitional dual seed does not fix generic SDKs that read the overwritten `TRACEPARENT`; upstream inbound propagation is required. Tempo's default idle flush with staggered job bursts and reads omitted persisted spans in the isolated reproduction despite accepting them, so ingestion must verify settled by-id completeness and reconcile or use the indexed per-job fallback. Per-job traces also remain the size fallback, not the default.
