# 0003 Daemon-Wait Attribution Joins at Ingest

Status: accepted

Accepted 2026-09-25 (decisions q12-reframe and q23; Johannes), on the
daemon-wait bakeoff (43-log corpus).

## Context

When two Buck commands share a daemon and one waits on work the other
produces, the waiter's own log is silent for the gap (the reproduced case: a
6.49 s gap, 54% of the waiter's wall, zero of its own action spans; at CI
scale a macOS build waited 79.5 s — 62% of its wall — on a concurrent test
command). q12 directed a bakeoff (hardened join vs attributes vs upstream
events) before deciding.

## Evidence and Argument

- **Upstream events are dead or partial:** `SharedTaskStart{owner_trace_id}`
  has had no producer since its emitting code was deleted upstream
  (2024-12, "not used anymore"; schema-only remnant — explains 0/46 corpus
  logs), and dice itself no longer depends on the events crate, so the old
  instrumentation point cannot be rebuilt as-is.
  `DiceBlockConcurrentCommand{current_active_trace_id}` _is_ emitted — but
  only for different-state blocking; it was reproduced exactly once in a
  deliberate reproduction (6,715.6 ms wait, owner id exact) and never in
  organic same-state concurrency.
- **The hardened join works:** peers scoped exactly by the daemon-provided
  `ConcurrentCommands.trace_ids[]`; DiceBlock read directly when present;
  otherwise inferred waits with causal producer ranking (producer ends at or
  before wake-up, identity absent from the waiter) and confidence tiers.
  Measured P 0.957 / R 1.0 at 500 ms and P = R = 1.0 at 1 s across 23
  emitted waits on 5 independent reproductions plus the CI corpus
  (coincidence baseline ~5%/gap on the densest peer; the single observed FP
  was suppressed by the 1 s threshold). Runtime is ms-level in the adapter.
- **The run record guarantees the batch:** ingest always sees all logs of a
  pipeline run, locally and in CI alike — the join's batch requirement costs
  nothing.
- **Upstream patch estimate:** ~200–350 lines injecting an event hook at the
  shared-task await; acceptance odds low-to-moderate with months of lag
  (PR #1370: open 2.5 months, zero reviews). The busy-waiter blind spot
  (lane starvation without a silent gap) is fixable only upstream.

## Options

| Option                                       | Tradeoff                                                                                    | Outcome                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Join at ingest + upstream track, not gated   | Exact where events exist, measured inference otherwise; traces contain marked derived spans | Accepted                                                |
| Join at ingest, no upstream work             | Zero upstream dependency; busy-waiter blind spot permanent                                  | Rejected — the blind spot is worth a parallel issue     |
| Attributes-only (gap summaries, no producer) | Buck-native spans only; "why waited" needs a manual second lookup                           | Rejected as the end state (kept as the always-on floor) |

## Decision

Daemon waits are attributed at ingest: `ConcurrentCommands` scoping, direct
`DiceBlockConcurrentCommand` reading, inferred daemon-wait spans with
confidence tiers and producer links, 1 s default threshold (500 ms opt-in),
gap summary attributes always on the command span. An upstream issue and a
small dice-hook PR are filed in parallel and never gate this design
([OQ2](../../open-questions.md)).

## Consequences

- Wait spans are derived evidence, explicitly marked (confidence tier,
  inferred flag) — the trace answers "why waited" directly while remaining
  regenerable from the record.
- Wait span ids derive from the waiter's invocation key + gap start, so
  re-joins are idempotent.
- If upstream ever ships owner events, the join demotes to fallback and the
  gap attributes remain.
