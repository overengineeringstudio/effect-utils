# Ingest and Archive Requirements

This subsystem owns the far end of the lane: converting sealed run records
into trace views and metrics (identically locally and on the fleet dev host),
their export to Tempo and Mimir, the raw-record archive and retention, and
the provider-neutral tagging of ingested runs. It refines BUCK.OBS-R03,
BUCK.OBS-R06, and BUCK.OBS-R08 of the
[07-observability requirements](../requirements.md).

## Assumptions

- **BUCK.OBS.ING-A01 Fleet backend:** Tempo (30 d) and Mimir are deployed by
  the dotfiles fleet config; this subsystem owns only the contract the
  ingester implements.
- **BUCK.OBS.ING-A02 Record batch:** ingest sees all native logs for one
  job-scoped CI record or one local invocation at once. A CI Pipeline Run
  accumulates several records and an attempt-close roster; no job's batch
  is mistaken for a complete run trace.

## Acceptable Tradeoffs

- **BUCK.OBS.ING-T01 Backend quirks designed around:** search visibility lag
  after push (minutes), int-typed attributes not matching TraceQL, and
  incomplete by-id reads despite accepted writes are worked around with
  string-typed attributes, deterministic ids, and by-id reconciliation;
  no successful push alone proves a complete trace.

## Requirements

- **BUCK.OBS.ING-R01 Identical ingest (refines BUCK.OBS-R03):** The same
  ingest command converts a sealed run record — anywhere: laptop or fleet dev
  host — through the adapter (03) into the views (04) and pushes chunked OTLP
  (chunks < ~3.5 MB; the gateway rejects larger bodies) to the collector and
  the bounded metrics to Mimir. No environment-specific branch exists.
- **BUCK.OBS.ING-R02 Deterministic identity (refines BUCK.OBS-R04):** With a
  caller context, the **critical view lives in the caller's trace** (trace id
  = the caller's; `buck2.command` parented under the pre-derived command
  span via the sidecar), and the **full view is a separate deterministic
  trace**, derived from SHA-256 of the Buck UUID followed by `:full`; its
  `buck2.command` root links to the caller command span. Without a caller
  context, both views have deterministic derived ids. Re-ingest and backfill
  reproduce the same ids without backend search, an API call, or the manifest
  digest.
- **BUCK.OBS.ING-R03 Archive (refines BUCK.OBS-R06):** Raw run records are
  archived in a dated, human-navigable layout that includes the job key,
  indexed by (repository, run, attempt, job), with a reconciliation index
  and a retention timer removing raw event logs after ~1 year within a
  bounded budget (≤150 GiB/yr at ~90 runs/day per q32, superseding q14's
  earlier figure; measured projection ~125 GiB/yr / ~351 MB/day,
  re-measured under [OQ1](../../open-questions.md)).
- **BUCK.OBS.ING-R04 Trace retention:** Tempo holds 30 days; long-term
  trends come only from the bounded metrics; no trace-level expectation
  beyond 30 d (older questions re-ingest from the archive).
- **BUCK.OBS.ING-R05 Provider-neutral run tagging (refines BUCK.OBS-R08):**
  Ingested runs carry provider-neutral attributes — `cicd.pipeline.run.*`,
  `cicd.worker.*`, `vcs.*` where the conventions exist, with the provider as
  one resource attribute (`ci.provider`); untrusted (fork) runs carry
  `ci.pr.fork=true` so queries can filter (02's trust signal decides
  upload; this stamps what arrived; OQ4 tracks the later cicd/vcs key
  migration).
- **BUCK.OBS.ING-R06 Search-independent discovery:** Ingest records the
  deterministic per-view trace ids and sealed VCS identity (ingest index,
  run summary) — never trace ids in the sealed manifest — and never depends
  on backend search or a provider API to discover a run.
- **BUCK.OBS.ING-R07 Deployment boundary:** effect-utils owns the single
  Rust `buck2-evidence` binary and in-process adapter for seal, upload,
  ingest, serve, drain, backfill, and retention. The dotfiles fleet config
  owns its hardened unit, two Unix sockets and managed Tailscale Services,
  storage, index deployment, Tempo tuning, and retention timer. Upload
  requires tailnet OIDC authorization; the resolver exposes only read access.
- **BUCK.OBS.ING-R08 Timely durable ingest:** A verified upload atomically
  records its archive index entry and pending ingest work; one immediate
  worker drains the persistent queue, and a periodic sweep recovers missed
  work. From job end to a clickable trace, the p95 target is ≤30 seconds
  plus upload time; a restarted service resumes pending work without silent
  loss.
- **BUCK.OBS.ING-R09 Cumulative readback:** Before a trace is marked
  complete, by-id readback confirms the union of expected deterministic span
  IDs from every job and root sharing that trace. Every later write triggers
  recheck of the whole set; a previously ingested record reverts to
  `missing_spans` if its spans disappear. Missing IDs are repushed
  selectively, never reported as complete without convergence.
- **BUCK.OBS.ING-R10 Bounded attempt closure:** The ingester accepts a
  provider-neutral attempt-close record (02) and writes exactly one CI run
  root after each expected job is ingested or marked missing, synthesizing
  error spans for missing jobs. If closure is absent or listed jobs remain
  unaccounted for, about six hours after the last upload the attempt is
  closed as `incomplete` with one root; an incomplete run is not presented
  as successful.
