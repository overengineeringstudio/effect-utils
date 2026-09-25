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
- **BUCK.OBS.ING-A02 Batch guarantee:** ingest always sees all logs of one
  pipeline run (the run record), locally and in CI alike.

## Acceptable Tradeoffs

- **BUCK.OBS.ING-T01 Backend quirks designed around:** search visibility lag
  after push (minutes) and int-typed attributes not matching TraceQL are
  worked around (string-typed attributes; deterministic ids recorded at
  ingest), not fixed in the backend.

## Requirements

- **BUCK.OBS.ING-R01 Identical ingest (refines BUCK.OBS-R03):** The same
  ingest command converts a sealed run record — anywhere: laptop or fleet dev
  host — through the adapter (03) into the views (04) and pushes chunked OTLP
  (chunks < ~3.5 MB; the gateway rejects larger bodies) to the collector and
  the bounded metrics to Mimir. No environment-specific branch exists.
- **BUCK.OBS.ING-R02 Deterministic identity (refines BUCK.OBS-R04):** Trace
  and span ids derive only from record-borne identity (artifact names,
  digests, invocation keys) — never from an API call — so re-ingest is
  idempotent and backfill reproduces identical traces.
- **BUCK.OBS.ING-R03 Archive (refines BUCK.OBS-R06):** Raw run records are
  archived in a dated, human-navigable layout indexed by (repository, run,
  attempt, job), with a reconciliation index and a retention timer removing
  raw event logs after ~1 year within a bounded budget (≤115 GiB/yr at ~90
  runs/day; measured ~3.9 MB/run).
- **BUCK.OBS.ING-R04 Trace retention:** Tempo holds 30 days; long-term
  trends come only from the bounded metrics; no trace-level expectation
  beyond 30 d (older questions re-ingest from the archive).
- **BUCK.OBS.ING-R05 Provider-neutral run tagging (refines BUCK.OBS-R08):**
  Ingested runs carry provider-neutral attributes — `cicd.pipeline.run.*`,
  `cicd.worker.*`, `vcs.*` where the conventions exist, with the provider as
  one resource attribute (`ci.provider`); untrusted (fork) runs carry an
  explicit trust marker so queries can filter (02's trust signal decides
  upload; this stamps what arrived).
- **BUCK.OBS.ING-R06 Search-independent discovery:** Ingest records the
  deterministic trace ids (manifest/index, run summary) and never depends on
  backend search for discoverability.
- **BUCK.OBS.ING-R07 Deployment boundary:** The ingester service, auth
  front, object-store ACL/lifecycle, index, and retention timer are
  implemented in the dotfiles fleet config against this contract; effect-utils
  owns the converter, uploader, manifest schema, id derivation, and this
  specification.
