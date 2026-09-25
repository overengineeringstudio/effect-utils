# Trace Views Spec

This document specifies the view rules, cap mechanics, summaries, and the
metrics set. It builds on [requirements.md](./requirements.md); its input is
the span model from [03-event-log-adapter](../03-event-log-adapter/spec.md)
and its destination is the export in
[05-ingest-and-archive](../05-ingest-and-archive/spec.md).

## Status

Draft.

## Scope

**Defines:** the two views' retention rules, threshold escalation, cap
behavior, summary attributes, and the bounded metrics.

**Does not define:** ingest transport and chunking (05), the adapter's span
model (03).

## View Selection

```text
span model (all spans, salted ids, daemon waits)
  ├─ critical view (default; always ingested)
  │    keep: roots + buck2.command
  │          critical-path actions + their stage children
  │          spans >= threshold (default 1 s) + all their ancestors
  │          daemon-wait spans
  │    escalate threshold only until span count <= cap (1,200)
  │    stamp: dropped_children on kept parents; exact command summaries
  └─ full view (always ingested; separately identified trace)
       keep: every span, unmodified
```

Both views derive deterministically from the same span model — the same run
record always yields the same two traces (idempotent re-ingest).

Measured shape on the largest cold-CI command (12,622 spans): full view
12.70 MB; the 1 s rule yields a **pre-escalation candidate** of ≈ 1,113–1,225
spans / ~1.6–1.8 MB (91–92% reduction) keeping 15 of 21 critical-path action
names and 543 actions — the cap then escalates the threshold to land at
≤ 1,200 stored spans (the span-cap benchmark's stored result: exactly 1,200 /
1.81 MB); at corpus scale, 66,948 spans → 5,870 (15 CI logs). The raw record
for that command is 711 KB — 5.6% of its full-view OTLP bytes — which is why
the record, not the trace store, is the forensic artifact.

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

## Metrics

Emitted at ingest alongside the views. **Canonical names are the OTel dotted
forms** (instrumentation emits OTLP); the Prometheus/Mimir translation below
is the single statement of the backend mapping (unit suffix `_seconds`,
counter suffix `_total`, dots → underscores) — dashboards and contract tests
query the Mimir names, and no other file restates them:

| Canonical (OTel)                      | Mimir / Prometheus                        | Type      | Labels (closed enums)               |
| ------------------------------------- | ----------------------------------------- | --------- | ----------------------------------- |
| `buck2.command.duration` (s)          | `buck2_command_duration_seconds`          | histogram | subcommand                          |
| `buck2.critical_path.duration` (s)    | `buck2_critical_path_duration_seconds`    | histogram | subcommand                          |
| `buck2.action.count`                  | `buck2_action_count_total`                | counter   | category, execution_kind, cache_hit |
| `buck2.action.execution.duration` (s) | `buck2_action_execution_duration_seconds` | histogram | category                            |
| `buck2.action.queue.duration` (s)     | `buck2_action_queue_duration_seconds`     | histogram | category                            |

Observed dimensions are bounded by Buck's enums (10–21 categories, 3–5
execution kinds across the corpus). Generic span-derived RED metrics cannot
answer queue/cache questions (their dimensions are service/name/kind/status);
the direct set is the long-term-trends feed for Mimir (05).

## Conformance

- Determinism: same record → byte-identical views (fixture-diffed).
- Cap behavior: a 12,622-span command yields exactly ≤ 1,200 spans with the
  mandatory structure intact (121 mandatory spans; escalation documented via
  the effective threshold attribute).
- Summaries exact against the full model at every cap.
- Evidence: [span-shaping and metrics](./.experiments/2026-09-25-span-shaping-and-metrics.md),
  [span-cap benchmark](./.experiments/2026-09-25-span-cap-benchmark.md),
  decisions [0001](./.decisions/0001-trace-view-family.md),
  [0002](./.decisions/0002-both-views-always-ingested.md).
