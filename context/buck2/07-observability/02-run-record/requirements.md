# Run Record Requirements

This subsystem owns the portable unit of build telemetry: one local invocation
or one CI job's run record (manifest + span spool + native evidence), its
capture and seal/upload lifecycle, and the attempt-close record that declares
the complete CI job roster and outcomes. It also owns the trust signal for
untrusted runs. It refines BUCK.OBS-R03, BUCK.OBS-R04, BUCK.OBS-R07, and
BUCK.OBS-R08 of the
[07-observability requirements](../requirements.md).

## Assumptions

- **BUCK.OBS.REC-A01 Spool exists:** the otel-span JSONL spool
  (`OTEL_SPAN_SPOOL_DIR`) is the existing span-capture mechanism, reused as
  the run record's span part.
- **BUCK.OBS.REC-A02 Content-addressed store:** a fleet object store with
  digest addressing and an optional conditional PUT is deployable by the
  dotfiles fleet config.
- **BUCK.OBS.REC-A03 Untrusted bytes:** a public repository's fork-run
  artifacts are attacker-controlled data (decision 0033's trust posture
  applies).

## Acceptable Tradeoffs

- **BUCK.OBS.REC-T01 Post-job delivery:** Delivery is not live; each job's
  record uploads after that job completes. The ingest queue targets a clickable
  trace within 30 seconds p95 plus upload time (05), without direct OTLP
  export ([OQ3](../open-questions.md)).
- **BUCK.OBS.REC-T02 One object-store namespace:** delivery needs one durable
  evidence namespace plus a write credential — accepted for local/CI parity,
  backfill, and archive in one mechanism.

## Requirements

- **BUCK.OBS.REC-R01 Same record everywhere (refines BUCK.OBS-R03):** Each
  local invocation and each CI job writes the same record shape to its spool:
  manifest, span spool, and native evidence (per-command event-log copies and
  build reports). Several CI job records belong to one Pipeline Run attempt.
  No CI-provider artifact API participates in producing a record.
- **BUCK.OBS.REC-R02 Capture wiring (refines BUCK.OBS-R07):** Traced callers
  run Buck with `--event-log <path> --write-build-id <path>` (the upstream
  flag writes the Buck trace id) and the caller-derived `BUCK_WRAPPER_UUID`
  (01); capture overhead is bounded
  (< 10 ms / < 0.1% of a working build) so it is unconditional, not opt-in.
- **BUCK.OBS.REC-R03 Seal:** Sealing freezes the manifest — file list, byte
  sizes, SHA-256 digests, schema version, producer and converter versions,
  run/attempt identity, event type, trust markers, and available PR/change
  identity plus head/base and merge-checkout revisions — before anything
  leaves the host. The PR number comes from the adapter environment;
  revisions are resolved from git at seal time, not inferred from provider
  run metadata. The lane-owned `buck2.vcs.merge.revision` identifies the
  merge commit; head is always the PR head and base the base revision.
  Trace ids are **not** manifest fields: they derive from a pre-manifest
  identity and are recorded by the ingest index (05), so the record digest
  never depends on them.
- **BUCK.OBS.REC-R04 Upload:** One provider-neutral, content-addressed PUT
  carries the sealed record (idempotent; conditional-create where supported);
  the local record is retained until an acknowledged commit; a missing
  credential is a deliberate _spool-only_ outcome, never data loss and never a
  build failure.
- **BUCK.OBS.REC-R05 Manifest portability (refines BUCK.OBS-R08):** No
  manifest field requires a specific CI provider; provider facts appear only
  as optional provider-neutral attributes (`cicd.*`, `vcs.*`,
  `buck2.vcs.merge.revision`), and no field carries hostnames, host paths,
  or usernames.
- **BUCK.OBS.REC-R06 Trust signal for untrusted runs:** Initial delivery
  admits trusted runs over an authenticated tailnet path and leaves fork runs
  spool-only. Later fork ingestion requires an explicit provider-level trust
  signal — on GitHub, a PR label — checked by a trusted adapter against the
  exact live PR head before granting a short-lived write capability. The
  build and uploader see only a generic capability, never provider label
  syntax.
- **BUCK.OBS.REC-R07 Bounded ingestion of untrusted bytes:** Ingest decodes
  untrusted records with the bounded Rust decoder only — no shell, per-file
  and total size caps, path-traversal rejection, digest verification before
  conversion — and never routes untrusted bytes to any external process
  (03: no `buck2 log show` fallback for untrusted records).
- **BUCK.OBS.REC-R08 Named deletions (refines BUCK.OBS-R09):** Landing the
  upload step supersedes the CI span-artifact upload step and any
  compatibility artifact re-ingest path; the transfer change deletes them.
- **BUCK.OBS.REC-R09 Attempt closure:** An always-run CI finalizer that
  depends on all jobs uploads one content-addressed attempt-close record by
  the same uploader. Its provider-neutral payload names the Pipeline Run
  attempt, expected matrix-qualified job keys and their conclusions; it
  contains no job's native evidence. Missing job records remain explicit
  rather than silently shrinking the roster.
