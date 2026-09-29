# Local Spool Requirements

This subsystem owns local native evidence and the retry spool for each Buck2 job or local invocation. It refines BUCK.OBS-R01, BUCK.OBS-R03, BUCK.OBS-R04, BUCK.OBS-R07, and BUCK.OBS-R09 of the [observability requirements](../requirements.md). Delivery policy belongs to [05](../05-otlp-delivery/requirements.md); trace identity and attempt closure belong to [01](../01-run-identity/requirements.md).

## Assumptions

- **BUCK.OBS.REC-A01 Local capture:** `OTEL_SPAN_SPOOL_DIR` already selects local JSONL span capture; Buck writes its own event logs, trace-id files, and build reports.
- **BUCK.OBS.REC-A02 Untrusted fork:** Fork-run processes can write local evidence but receive no fleet delivery authority.

## Acceptable Tradeoffs

- **BUCK.OBS.REC-T01 Best-effort retention:** Evidence and unsent telemetry survive delivery failures locally, but no fleet archive, guaranteed cross-run backfill, or retention beyond the lifetime of the local spool exists.

## Requirements

- **BUCK.OBS.REC-R01 Same local capture everywhere (refines BUCK.OBS-R03):** Local and CI commands use the same span spool and native-evidence capture. Each Buck command retains its own event-log copy, Buck trace-id file, and build report when produced; neither a sealed run record nor a CI artifact is required to export traces.
- **BUCK.OBS.REC-R02 Capture wiring (refines BUCK.OBS-R07):** Traced callers run Buck directly with `--event-log <path> --write-build-id <path>` and the validated caller-derived `BUCK_WRAPPER_UUID` (01). Capture overhead remains bounded (<10 ms / <0.1% of a working build) and is unconditional.
- **BUCK.OBS.REC-R03 Evidence identity:** The adapter-supplied PR/change identity, head and base revisions, and separate merge-checkout revision are represented as trace attributes when available; native evidence stays local. A missing identity is omitted, never inferred from a CI run object's PR association. Neither a manifest digest nor a provider API lookup determines trace identity.
- **BUCK.OBS.REC-R04 Retry safety (refines BUCK.OBS-R04):** Failed or unacknowledged OTLP delivery retains the affected local telemetry for retry. A missing endpoint or tailnet admission yields spool-only; telemetry failure cannot change the build result or discard native evidence. 05 owns the transport and retry protocol.
- **BUCK.OBS.REC-R05 Portability (refines BUCK.OBS-R08):** Telemetry and portable fixtures contain no hostnames, host paths, usernames, or fleet endpoints; provider facts are optional attribute values, not transport control flow.
- **BUCK.OBS.REC-R06 Fork boundary:** Ordinary forks remain spool-only with no OTLP export credential or tailnet join. A future fork admission requires a separately approved trust and network boundary; a GitHub label alone is not current authorization.
- **BUCK.OBS.REC-R07 Native evidence authority (refines BUCK.OBS-R01):** Event logs and build reports remain execution truth. Adapter decode and delivery failures are visible diagnostics, not changes to the Buck result; untrusted bytes cannot cause an external decode fallback.
- **BUCK.OBS.REC-R08 Named deletions (refines BUCK.OBS-R09):** Direct delivery supersedes CI span-artifact upload, run-record seal/content-addressed upload, and artifact re-ingest. The transfer removes those mechanisms rather than maintaining a compatibility route.
- **BUCK.OBS.REC-R09 Attempt closure:** A CI finalizer depending on work jobs emits the 01 pipeline-run link trace after the attempt closes. It does not seal or upload a roster record, synthesize missing-job spans, or wait for an ingest worker.
