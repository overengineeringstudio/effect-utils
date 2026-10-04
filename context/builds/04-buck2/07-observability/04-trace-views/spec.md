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
  ├─ critical view (default; seeded: job trace; unseeded: command trace)
  │    keep: roots + buck2.command
  │          critical-path actions + stage children
  │          spans >= threshold (default 1 s) + ancestors
  │          daemon-wait spans
  │    escalate threshold to span count <= 1,200
  │    stamp: dropped_children; exact command summaries
  └─ full view (separate deterministic trace; link only if caller exists)
       keep: every span
```

Both views derive deterministically from the same local event log and
sidecar context. With a valid caller span, the critical view is parented
beneath its task and command spans in the job trace; a local task run has
a job-equivalent trace. The full-view root links to the command span.
Without a valid caller context (ID-R07), the adapter exports the critical
view as an independent root rather than inventing a missing job/task span;
the separate full-view root has no caller link.

For independent views, parse the Buck trace UUID as 16 bytes and format it
as exactly 32 lowercase hexadecimal characters without hyphens. The
critical/full trace IDs are the first 16 bytes of
`SHA-256(UTF-8(canonical UUID + ":critical"))` and
`SHA-256(UTF-8(canonical UUID + ":full"))`, respectively; if the 16 bytes
are all zero, rehash the original input with an appended `u32be(counter)`
starting at 1. The same full-view rule applies to seeded commands; a seeded
critical view instead inherits the caller job trace ID. Job roots carry
`cicd.pipeline.run.id` for run lookup. Eligible completed views export to
the configured collector under consumer admission; forks keep only the local spool. Neither view needs an archived
record or read-time transformation.

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

The deterministic job trace ID derives from the run ID and canonical
matrix-qualified key ([01](../01-run-identity/spec.md)); every job root has
`cicd.pipeline.run.id`. A seeded command's critical view shares that job
trace while its full-view root links to the command span. Without context,
critical and full roots use the independent IDs above and cannot be found
by an absent pipeline-run ID. Grafana links can use derived IDs without a
resolver; neither a link nor a Tempo query proves that export succeeded.

## Metrics

Local conversion emits metrics alongside the completed traces. Canonical
names are OTel dotted names; Prometheus-compatible translation adds `_seconds`
to seconds-valued histograms, `_total` to counters, and replaces dots with
underscores:

| Canonical (OTel)                      | Prometheus-compatible                        | Type      | Labels (closed enums)               |
| ------------------------------------- | ----------------------------------------- | --------- | ----------------------------------- |
| `buck2.command.duration` (s)          | `buck2_command_duration_seconds`          | histogram | subcommand                          |
| `buck2.critical_path.duration` (s)    | `buck2_critical_path_duration_seconds`    | histogram | subcommand                          |
| `buck2.action.count`                  | `buck2_action_count_total`                | counter   | category, execution_kind, cache_hit |
| `buck2.action.execution.duration` (s) | `buck2_action_execution_duration_seconds` | histogram | category                            |
| `buck2.action.queue.duration` (s)     | `buck2_action_queue_duration_seconds`     | histogram | category                            |

These bounded dimensions support long-term trends independently of consumer-selected
trace retention. No target, digest, run id, trace id, or host label
enters a metric series.

## Conformance

- Determinism: same local log and sidecar context → byte-identical views.
- Cap behavior: a 12,622-span command yields exactly ≤ 1,200 spans with the
  mandatory structure intact (121 mandatory spans; escalation documented via
  the effective threshold attribute).
- Summaries exact against the full model at every cap.
- An unseeded Buck command exports two independent, distinct, nonzero
  deterministic trace IDs without a fabricated task span or caller link;
  a seeded command puts only its critical view in the job trace.
- Evidence: [span-shaping and metrics](.experiments/2026-09-25-span-shaping-and-metrics.md),
  [span-cap benchmark](.experiments/2026-09-25-span-cap-benchmark.md),
  decisions [0001](.decisions/0001-trace-view-family.md),
  [0002](.decisions/0002-both-views-always-ingested.md).
