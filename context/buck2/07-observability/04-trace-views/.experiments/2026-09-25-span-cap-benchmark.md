# Span-cap benchmark (SpanCapBench)

Date: 2026-09-25 · Input: the largest cold-CI command (12,622 spans / 12.70 MB
OTLP / 2,160 actions / 603 cache hits / 21 critical-path actions); heavy and
variable host load — absolute times directional, counts/bytes/sizes exact.

## Question

Which ingest-time cap for the critical view best serves Grafana's trace view,
trace-island dashboards, and TraceQL: 300, 600, 1,200, 2,500, 5,000, or no
cap — versus retaining the full trace and choosing at read time?

## Method

- Six candidates generated from the same command with the projection rule
  (mandatory structure = 121 spans; remaining budget filled by descending
  span duration — escalation, not input-order truncation).
- Trace-backend fetch per candidate (n=5); TraceQL critical/cache searches
  scoped by trace id (n=5 per query/candidate).
- Headless-browser Grafana trace view per candidate (isolated session, fresh
  open, import-to-visible, heap + DOM sampled, n=5).
- A published dashboard page with one trace-island per candidate, driven
  through all six (cumulative heap/DOM; progressive lazy readiness).
- Semantic retention tables: action spans, action names, targets, sub-second
  and cache-hit children retained vs dropped, per cap.

## Result

- Fetch (median): 126 ms @300 · 143 @600 · 224 @1,200 · 316 @2,500 · 566
  @5,000 · 1,079 @full — monotonic; full is 4.8× the 1,200 fetch. TraceQL
  itself is cap-insensitive once scoped by trace id (65–85 ms medians).
- Grafana isolated: cap-insensitive within noise (81–119 MB heap, ~1.1–1.7 s
  visible; full +~0.5 s / ~15 MB vs 1,200); the 12.6 k full trace rendered
  without failure here.
- Dashboard page (the worse consumer): cumulative heap 1.13 GB after 1,200,
  1.39 GB after full (+262 MB; +4.4 s readiness); earlier isolated evidence
  had ~600 spans ≈ 200 MB and a 21 k-span trace crash at 3 GB — many large
  islands on one page are unsafe as a general pattern.
- Semantics: 600 keeps 10/21 critical names + 256 actions, drops 77% of
  actions and 596/603 cache-hit children; 1,200 keeps 15/21 + 543 (still
  drops 1,617 sub-second actions); 2,500 adds little for +92% bytes (poor
  knee); 5,000 finally keeps 564/603 cache-hit children at 3.4× bytes
  (opt-in forensic tier); full is the only complete one. Command summaries
  carry the exact cache ratio at every cap.
- Read-time caps rejected on mechanics: consumers would disagree on trace
  content; TraceQL cannot query unstored spans; every client would need to
  understand projection semantics. Two stored traces is the honest adaptive
  design.

## Conclusion

1,200 is the knee (recommended default cap), with 600 the fallback if
interactive heap matters more than breadth, 2,500 dominated, 5,000/full as
explicit diagnostic tiers. The recommendation was critical-only + on-demand
full from the archive; Johannes chose both views always ingested (decision
q24) with this benchmark as the volume evidence — recorded unchanged.
Confidence: medium-high for the cap policy; high for semantic/fetch
tradeoffs; medium for exact browser timings.

## VRS Impact

Grounded [BUCK.OBS.VIEW-R01..R03](../requirements.md) and
[decision 0002](../.decisions/0002-both-views-always-ingested.md); the
unmeasured fleet-scale volume of the both-views choice is
[OQ1](../../open-questions.md). What would change it: a reproducible
1,200-span crash or an agreed interactive heap budget (→ 600 default); a
corpus where >10% of commands lose critical structure at 1,200 (→ revise
ranking before raising the cap).
