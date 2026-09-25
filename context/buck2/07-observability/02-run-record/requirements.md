# Run Record Requirements

This subsystem owns the portable unit of build telemetry: the run record
(manifest + span spool + native evidence), its capture wiring, and the
seal/upload lifecycle, including the trust signal for untrusted runs. It
refines BUCK.OBS-R03, BUCK.OBS-R04, BUCK.OBS-R07, and BUCK.OBS-R08 of the
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

- **BUCK.OBS.REC-T01 Minutes-level latency:** bundle delivery is not live;
  telemetry lands after the run completes. Live export is a later optional
  fast path ([OQ3](../open-questions.md)).
- **BUCK.OBS.REC-T02 One object-store namespace:** delivery needs one durable
  evidence namespace plus a write credential — accepted for local/CI parity,
  backfill, and archive in one mechanism.

## Requirements

- **BUCK.OBS.REC-R01 Same record everywhere (refines BUCK.OBS-R03):** Every
  pipeline run — laptop or CI — writes the same local artifacts into its spool
  directory: the manifest, the span spool, and the native evidence (explicit
  per-invocation event-log copies and build reports). No CI-provider artifact
  API participates in producing the record.
- **BUCK.OBS.REC-R02 Capture wiring (refines BUCK.OBS-R07):** Traced callers
  run Buck with `--event-log <path> --write-build-id <path>` and the
  caller-derived `BUCK_WRAPPER_UUID` (01); capture overhead is bounded
  (< 10 ms / < 0.1% of a working build) so it is unconditional, not opt-in.
- **BUCK.OBS.REC-R03 Seal:** Sealing freezes the manifest — file list, byte
  sizes, SHA-256 digests, schema version, producer and converter versions,
  deterministic trace ids, run/attempt identity, event type, and trust
  markers — before anything leaves the host.
- **BUCK.OBS.REC-R04 Upload:** One provider-neutral, content-addressed PUT
  carries the sealed record (idempotent; conditional-create where supported);
  the local record is retained until an acknowledged commit; a missing
  credential is a deliberate _spool-only_ outcome, never data loss and never a
  build failure.
- **BUCK.OBS.REC-R05 Manifest portability (refines BUCK.OBS-R08):** No
  manifest field requires a specific CI provider; provider facts appear only
  as optional provider-neutral attributes (`cicd.*`, `vcs.*`), and no field
  carries hostnames, host paths, or usernames.
- **BUCK.OBS.REC-R06 Trust signal for untrusted runs:** An untrusted run's
  record is uploaded only when an explicit, provider-level trust signal
  authorizes it — on GitHub: a PR label (livestore prior art). The build and
  uploader see only a generic short-lived write capability, never provider
  label syntax; authorization binds to the exact PR head and is re-checked
  before use.
- **BUCK.OBS.REC-R07 Bounded ingestion of untrusted bytes:** Ingest decodes
  untrusted records with the bounded Rust decoder — no shell, per-file and
  total size caps, path-traversal rejection, digest verification before
  conversion.
- **BUCK.OBS.REC-R08 Named deletions (refines BUCK.OBS-R09):** Landing the
  upload step supersedes the CI span-artifact upload step and any compatibility
  replay; the transfer change deletes them.
