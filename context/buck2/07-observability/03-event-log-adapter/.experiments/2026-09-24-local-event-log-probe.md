# Local event-log probe (LocalEventLogProbe)

Date: 2026-09-24 · The only surviving local corpus: 7 harvested logs from one
worktree (Buck keeps only recent logs per isolation dir; no historical corpus
exists locally, and CI logs were lost with runners before the capture step
existed — the gap this lane closes).

## Question

What do the built-in event-log tools say about local build bottlenecks, and
what is missing from the built-in surface?

## Method

- Harvested every surviving `*_events.pb.zst` from the worktree's log
  directory; analyzed 4 representative logs (a 1,241-action check aggregate;
  a 427 s editor-view build; a 4.2 s 296-action build; a single validation
  action) with `log show` + `critical-path` aggregation, cross-checked
  against `log summary`.
- Systematic usefulness audit of every `log what-*`/`summary`/
  `critical-path`/`chrome-trace`/`diff` command against the bottleneck
  questions (where did time go; why did this action wait; what uploaded).

## Result

- Local bottlenecks are **cache I/O, not compute**: synchronous action-cache
  upload p50 2.5–3.1 s per action (5.12 s for a 132-byte output) sits inside
  action spans and on the critical path; the check aggregate's critical
  action = 3.07 s queued + 2.83 s upload + 0.003 s execute; 249 extract
  actions summed 489 s queued vs 3.1 s executing; 622 cache queries summed
  389 s. One remote-CAS materialization = 421.45 of 427 s wall (7,243 files /
  15.6 MB at ~503 KiB/s).
- Built-in surface verdicts: `critical-path` is the most useful (which
  action, not why); `log show` is the only stage-level truth but needs
  custom aggregation; `what-uploaded` and `summary` report 0 B despite 294
  successful upload spans (895 s summed) — action-cache uploads are invisible
  to both; `chrome-trace` silently drops most actions at default track
  limits; `what-materialized` has no durations; cache misses are visible but
  not explained (the divergence diff compares outputs, not keys).
- Missing entirely: any OTLP/trace path; cross-invocation aggregation or
  retention; stage breakdowns in ready-made reports; materialization timing;
  a cache-miss explanation.

## Conclusion

The event log already contains the decisive local signals — but only through
raw decoding and custom aggregation, and nothing survives the machine. The
adapter + run-record lane is the missing bridge; the measured cache-service
latency belongs to its owners (04-reuse / fleet service), not this lane.
Confidence: high (complete surviving corpus, cross-checked reports).

## VRS Impact

Motivating evidence for the whole lane (q6) and for direct decode
([decision 0001](../.decisions/0001-direct-decode-rust-crate.md)): the
stage split exists _only_ in raw spans. The upload/materialization latency
findings are cross-referenced to
[04-reuse](../../../04-reuse/open-questions.md) (q8).
