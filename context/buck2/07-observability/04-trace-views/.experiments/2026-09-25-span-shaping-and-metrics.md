# Span shaping and bounded metrics (B6)

Date: 2026-09-25 · Corpus: 22 logs (15 CI, 3.78 MiB compressed total; 7
local); heavily loaded host (71–82) — wall times directional, counts and
bytes exact.

## Question

Which trace shape should be the default in Tempo while preserving the
answers to: what was on the critical path; which categories dominated
execution/queue time; what was the cache-hit ratio; why was this task slow?
Candidates: full, threshold projections (0.5/1/2/4 s), aggregate rollup,
full-to-disk. Metrics assessed separately (span-derived RED vs direct
bounded series).

## Method

- A shape tool applying the projection rule family (roots/command,
  critical-path spans + stage children, threshold + ancestors,
  dropped-children counts) over the full corpus; OTLP bytes summed per
  shape.
- Ingest benchmark: the largest CI command (12,622 spans) pushed per shape
  (n=5); direct trace-backend readback per shape; TraceQL searches scoped by
  trace id (n=5); a headless-browser Grafana render per shape (cold session,
  import-to-visible).
- Command summary attributes added so cache ratio survives any cap.
- Cardinality audit of category/execution-kind dimensions across the corpus.

## Result

- Volume (15 CI logs): full 66,948 spans / 66.64 MB; projection 1 s 5,870 /
  8.25 MB (91.2%/87.6% reduction); 2 s 3,416 / 4.85 MB; aggregate 1,155 /
  1.38 MB. Raw logs = 3.78 MiB = 5.7% of full OTLP — full-to-disk is the
  cheap forensic artifact.
- Largest command: POST median 158 ms (full) vs 17–23 ms (projections);
  readback 11.2 s (full) vs 0.25–0.5 s (1–4 s projections) vs 0.82 s
  (aggregate); Grafana render 15.6 s (full) vs 11.9 s (2 s projection) vs
  11.5 s (aggregate) over an ~11.5 s app-startup floor.
- Readability: the 2 s projection exposed command, critical actions/stages,
  slow actions, and usable waterfall structure; the aggregate answers
  category dominance (`tsgo_typecheck` 816.8 s execute sum, `tsgo_emit`
  223.5 s) but keeps only 21 action details — a rollup, not a trace. The
  adaptive "until ≤600 spans" rule under examination retained 1,200–1,600
  spans and stayed slow — fixed thresholds + hard cap are predictable.
- Cache ratio exact only in full until command summaries were added (then
  exact at every shape).
- Metrics: observed dimensions 10 categories / 3 execution kinds (local) to
  21 / 4 (largest CI command) — closed enums, bounded by Buck. Five direct
  series proposed (`command.duration`, `critical_path.duration`,
  `action.count{category,execution_kind,cache_hit}`,
  `action.execution.duration`, `action.queue.duration`); span-derived RED
  cannot express queue/cache semantics without custom connector dimensions.

## Conclusion

The default Tempo trace is a **1 s projection with a hard cap** (cap value
settled by the follow-up span-cap benchmark at 1,200) plus exact command
summaries; the raw event log is the forensic full-detail copy; aggregate
rollups are metrics, not traces; the five bounded direct metrics are the
long-term trends feed. Confidence: high for volume/policy and metric labels;
medium for exact UI timings.

## VRS Impact

Settled the critical-view rule and the metrics set
([BUCK.OBS.VIEW-R02/R05/R06](../requirements.md)); the cap and the
both-views policy were settled by the follow-up benchmark and decision q24
([0002](../.decisions/0002-both-views-always-ingested.md)).
