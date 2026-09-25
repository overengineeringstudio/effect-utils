# 0002 Both Views Are Always Ingested

Status: accepted

Accepted 2026-09-25 (decision q24; Johannes — "go with both views for now;
dial in later if volume issues appear"), superseding the bakeoff's
recommended critical-only default.

## Context

The span-cap benchmark recommended storing only the capped critical view
(1,200) with the full view on demand from the archive. Johannes chose full
queryability over storage frugality: both views are ingested as two
identified traces, with no read-time caps, until measured evidence says
otherwise.

## Evidence and Argument

- Full-view costs are real and measured: ~11× the critical view's volume
  (~67 k spans / ~61 MB OTLP per CI run vs ~6 k / ~8 MB); full-trace fetch
  median 1.08 s vs 0.22 s; a many-island dashboard page reached 1.39 GB
  cumulative heap after a full view (1.13 GB after 1,200); earlier evidence
  saw a 21 k-span trace crash a 3 GB browser.
- Full-view benefits are equally real: it is the only candidate that can
  directly inspect every cache-hit and sub-second child — the audit questions
  the critical view structurally cannot answer (at 1,200, 1,617 sub-second
  actions and 596 cache-hit children are dropped).
- Read-time caps were rejected on mechanics, not preference: consumers would
  disagree on what a trace contains, and TraceQL cannot query spans that were
  never stored. Two _stored_ views is the only honest adaptive design.
- The archive (05) keeps full detail regenerable regardless — the decision is
  about what is _immediately queryable_, with the volume measurement
  ([OQ1](../../open-questions.md)) as the dial-in trigger.

## Options

| Option                                        | Tradeoff                                                 | Outcome           |
| --------------------------------------------- | -------------------------------------------------------- | ----------------- |
| Both views always ingested, no read-time caps | Full queryability; ~11× volume, measured plan to dial in | Accepted (q24)    |
| Critical view only, full on demand            | Bakeoff-recommended default; misses child-level audits   | Superseded by q24 |
| Critical + full only on failure runs          | Middle ground; splits semantics by outcome               | Not chosen        |

## Decision

Ingest both the critical view (1 s threshold, hard cap 1,200, threshold
escalates only to meet the cap, exact command summaries) and the full view as
two identified traces for every command. No read-time caps. The unmeasured
Tempo volume at fleet scale is recorded as [OQ1](../../open-questions.md)
with a measurement plan and explicit dial-in options; if the corridor budget
is exceeded, the fallback is critical-only + on-demand re-ingest.

## Consequences

- Every stored span is queryable; the critical view remains the interactive
  default surface for humans and dashboards.
- Tempo storage carries ~67 k spans / ~61 MB per CI run at ~90 runs/day
  until the measurement lands (BUCK.OBS-T02).
- The full view is still regenerable from the archive — the two stored views
  are conveniences, not the forensic copy (BUCK.OBS-R01).
