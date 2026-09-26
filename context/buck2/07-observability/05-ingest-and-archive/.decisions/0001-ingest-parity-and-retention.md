# 0001 Ingest Parity, Archive, and the Rejected Replay Baseline

Status: accepted

Accepted 2026-09-25 (decisions q14 and q18; Johannes; the archive budget
figure was superseded by q32, 2026-09-25), on the retention question and
the CI→Tempo replay prototype (B7, recorded as the rejected baseline).

## Context

Run records must become queryable traces and must stay forensically available
far beyond trace retention. The delivery bakeoff (02, q18) settled the
transport: records are uploaded, not replayed from a CI provider. What
remained was the ingest identity, the retention split, and where deployment
lives.

## Evidence and Argument

- The replay prototype proved the far-side mechanics end to end for a real
  3-job run: download → restitch → convert → push in 10.4 s median, 8 API
  requests and 3.93 MB per run, deterministic ids from artifact-borne
  identity, three consecutive pushes idempotent (stable span counts, no
  duplicates), log→task assignment 15/15 by the serial-command invariant,
  and verified readback (`buck2.command ← devenv.task.exec ← ci.job`, zero
  dangling parents) — but its trigger, format, retention, and downloader are
  all one provider's, which is why it is the baseline, not the design
  ([experiment](../.experiments/2026-09-25-ci-to-tempo-replay-baseline.md)).
- Direct OTLP from runners fails the fork case structurally (no secrets on
  fork runners) and needs an authenticated ingest that does not exist yet.
- Tempo's existing 30-day retention already exceeds the 14-day CI artifact
  window; long-term trend questions are answerable by bounded metrics, and
  raw logs are small: ~3.9 MB/run measured, ~125 GiB/yr at 90 runs/day —
  cheap against bulk storage.
- Operational findings to design around, not fix: int-typed attributes do
  not match TraceQL; fresh pushes stay search-invisible ≥ 22 min; the
  gateway rejects large single bodies (~27.9 MB → 400).

## Options

| Option                                                                                        | Tradeoff                                                           | Outcome        |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------- |
| Record upload + identical local/dev-host ingest; Tempo 30 d + Mimir trends + ~1 y raw archive | Local/CI parity, backfill, forensics; deployment work in dotfiles  | Accepted       |
| Direct OTLP-only ingest                                                                       | Lowest latency; forks structurally excluded; auth/flush gaps       | Rejected       |
| CI-provider artifact replay                                                                   | Proven (the baseline); maximal provider coupling, 14-day window    | Rejected (q18) |
| Raise Tempo retention (e.g. 180 d)                                                            | Longer trace forensics; unmeasured disk impact on all fleet traces | Rejected       |

## Decision

Ingest converts sealed run records through the adapter into both views and
bounded metrics, identically locally and on the fleet dev host, with ids
derived only from a pre-manifest record-borne identity (view placement and
per-view ids per [05](../spec.md): with a caller context the critical view
lives in the caller's trace and the full view is a separate linked trace).
Tempo keeps 30 days; long-term trends come from the bounded metrics; raw
run records are archived ~1 year in the dated, job-keyed, indexed layout
with a retention timer, within a **≤150 GiB/yr corridor at the planning
volume** (measured projection ~125 GiB/yr). This supersedes the ≤115 GiB/yr
figure recorded with q14 by Johannes's explicit follow-up answer (q32,
2026-09-25: ≤150 GiB/yr, 1-year retention, re-measured under
[OQ1](../../open-questions.md)).
The ingester service, auth front, store ACL/lifecycle, index, and timer are
implemented by the dotfiles fleet config against this contract; no CI-artifact
replay is built, and direct OTLP remains a later optional fast path
([OQ3](../../open-questions.md)).

## Amendment 1 — Full-view identity (2026-09-26, q38)

Johannes chose the shipped `SHA-256(Buck UUID + ":full")` derivation for the
full-view trace id, projected to an OTLP trace id. The earlier
`f(repository, run, attempt, job, Buck trace id, view kind)` description in
the [05 spec](../spec.md) is superseded: the Buck UUID already derives from
the caller trace and command span, and the caller trace carries run/attempt
identity. The critical view remains in the caller trace with a caller
context; do not break its parent/child relationship to implement the full
view. The run record captures change id and git head/base/merge revisions at
seal time; the index carries them forward instead of querying a provider
whose PR-to-run association may be absent. The sibling [run-record
spec](../../02-run-record/spec.md) owns the sealed field schema.

The alternative—changing shipped ids to add repository/run/attempt/job
again—would require re-ingesting existing traces with no functional
gain after caller identity is seeded. Provider-side PR lookup is rejected
because a run can have no usable PR association.

The upload/worker choice and Tempo repair are recorded separately in
[decision 0002](./0002-durable-ingest-and-tempo-readback.md).

## Consequences

- Ingest code has exactly one path to maintain; a laptop can re-ingest any
  archived run with the same ids. Later Tempo 3.0.3 probes show that
  deterministic ids alone do not prevent duplicates on a fast repush:
  [decision 0002](./0002-durable-ingest-and-tempo-readback.md) requires
  chunk checkpoints, a by-id probe, and complete readback.
- Fork-run traces arrive only through 02's trust signal and carry
  `ci.pr.fork=true`; the bounded decoder is the poison boundary.
- Tempo volume under both-views ingest is unmeasured and tracked
  ([OQ1](../../open-questions.md)) with dial-in options.
