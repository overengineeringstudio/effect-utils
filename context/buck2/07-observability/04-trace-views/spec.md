# Trace Views Spec

This document specifies view rules, cap mechanics, and command summaries.
It builds on [requirements.md](./requirements.md), consumes the local span
model from [03](../03-event-log-adapter/spec.md), and sends completed traces
through the direct export path in [05](../05-otlp-delivery/spec.md).

## Status

Draft.

## Scope

**Defines:** both stored views, threshold escalation, cap behavior, command
summaries, bounded metrics, and trace lookup fields.

**Does not define:** direct OTLP transport (05) or adapter decoding (03).

## View Selection

```text
local span model (salted ids, daemon waits)
  ├─ critical view (default; emitted into job trace beneath task span)
  │    keep: roots + buck2.command
  │          critical-path actions + stage children
  │          spans >= threshold (default 1 s) + ancestors
  │          daemon-wait spans
  │    escalate threshold to span count <= 1,200
  │    stamp: dropped_children; exact command summaries
  └─ full view (separate deterministic trace linked to command span)
       keep: every span
```

Both views derive deterministically from the same local event log and sidecar
context. The critical view is parented beneath the caller task span in the
job trace; a local task run uses a job-equivalent trace. The full trace root
links to the caller command span. Job roots carry `cicd.pipeline.run.id`
for run lookup. Completed eligible job views export directly to dev3 Alloy;
an ordinary fork keeps only its local spool. Neither view requires an
archived run record or read-time projection.

Measured shape on the largest cold-CI command (12,622 spans): full view
12.70 MB; the 1 s rule yields a **pre-escalation candidate** of ≈ 1,113–1,225
spans / ~1.6–1.8 MB (91–92% reduction) keeping 15 of 21 critical-path action
names and 543 actions — the cap then escalates the threshold to land at
≤ 1,200 stored spans (the span-cap benchmark's stored result: exactly 1,200 /
1.81 MB); at corpus scale, 66,948 spans → 5,870 (15 CI logs). The native
event log was 711 KB for that command; it remains local conversion evidence,
not a remotely retained forensic archive.

## Why 1,200

| Evidence             | Numbers                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trace fetch (median) | 126 ms @300 · 143 @600 · 224 @1,200 · 316 @2,500 · 566 @5,000 · 1,079 @full                                                                           |
| Grafana render       | cap-insensitive (81–119 MB heap, ~1.1–1.7 s visible); full adds ~0.5 s / ~15 MB                                                                       |
| Vista trace islands  | one page: 1.13 GB cumulative after 1,200; full pushes it to 1.39 GB (earlier evidence: 21 k spans crashed a 3 GB browser)                             |
| Breadth              | 600 keeps 10/21 critical names + 256 actions; 1,200 keeps 15/21 + 543; 2,500 adds little for +92% bytes (poor knee); 5,000 is an opt-in forensic tier |
| Exactness            | command summaries make the cache ratio exact at every cap (603/2,160 = 27.92% retained as attributes)                                                 |

## Command Summary Attributes

Every view's command span carries `buck2.action_count`,
`buck2.cache_hit_count`, `buck2.critical_path_action_count` (plus
subcommand), so "what was the cache-hit ratio" never depends on child
retention.

## Trace Lookup

The deterministic job trace id derives from the run id and matrix-qualified
job key ([01](../01-run-identity/spec.md)); every job root has
`cicd.pipeline.run.id`. Task spans belong to that job trace, while full-view
roots link to their critical-view command span. Grafana links can use derived
trace ids without a resolver, while Tempo search over
`.cicd.pipeline.run.id` can find exported job roots. Neither query is a
promise that late or failed exports are already visible.

## Metrics

Local conversion emits metrics alongside the completed traces. Canonical
names are OTel dotted names; Prometheus/Mimir translation adds `_seconds`
to seconds-valued histograms, `_total` to counters, and replaces dots with
underscores:

| Canonical (OTel)                      | Mimir / Prometheus                        | Type      | Labels (closed enums)               |
| ------------------------------------- | ----------------------------------------- | --------- | ----------------------------------- |
| `buck2.command.duration` (s)          | `buck2_command_duration_seconds`          | histogram | subcommand                          |
| `buck2.critical_path.duration` (s)    | `buck2_critical_path_duration_seconds`    | histogram | subcommand                          |
| `buck2.action.count`                  | `buck2_action_count_total`                | counter   | category, execution_kind, cache_hit |
| `buck2.action.execution.duration` (s) | `buck2_action_execution_duration_seconds` | histogram | category                            |
| `buck2.action.queue.duration` (s)     | `buck2_action_queue_duration_seconds`     | histogram | category                            |

These bounded dimensions support long-term trends independently of Tempo's
30-day trace retention. No target, digest, run id, trace id, or host label
enters a metric series.

## Conformance

- Determinism: same local log and sidecar context → byte-identical views.
- Cap behavior: a 12,622-span command yields exactly ≤ 1,200 spans with the
  mandatory structure intact (121 mandatory spans; escalation documented via
  the effective threshold attribute).
- Summaries exact against the full model at every cap.
- Evidence: [span-shaping and metrics](./.experiments/2026-09-25-span-shaping-and-metrics.md),
  [span-cap benchmark](./.experiments/2026-09-25-span-cap-benchmark.md),
  decisions [0001](./.decisions/0001-trace-view-family.md),
  [0002](./.decisions/0002-both-views-always-ingested.md).
