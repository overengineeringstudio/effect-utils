# OTLP Delivery Requirements

This subsystem owns direct OTLP export of [03](../03-event-log-adapter/spec.md) and [04](../04-trace-views/spec.md) output, plus local retry of undelivered telemetry. It refines BUILD.BUCK.OBS-R01, BUILD.BUCK.OBS-R03, BUILD.BUCK.OBS-R04, BUILD.BUCK.OBS-R05, BUILD.BUCK.OBS-R06, and BUILD.BUCK.OBS-R08 of the [observability requirements](../requirements.md).

## Assumptions

- **BUILD.BUCK.OBS.ING-A01 Fleet backend:** dev3 Alloy accepts OTLP/HTTP on tailnet port 4318 and forwards traces to Tempo (30 days) and bounded metrics to Mimir; dotfiles owns fleet routing, ACL, and backend configuration.
- **BUILD.BUCK.OBS.ING-A02 Local source:** each completed job or local invocation has its native evidence and captured spans available on the producing host (02); job-trace and pipeline-run trace identities come from 01, and a local invocation's trace is the local equivalent of a job trace.

## Acceptable Tradeoffs

- **BUILD.BUCK.OBS.ING-T01 Best-effort backend completeness:** Tempo acceptance and search visibility can lag or be incomplete. The local retry spool protects unacknowledged sends; no server-side archive, by-ID readback, or reconciliation service guarantees trace completeness.

## Requirements

- **BUILD.BUCK.OBS.ING-R01 Same exporter (refines BUILD.BUCK.OBS-R03):** CI and local runs use the same adapter, trace views, OTLP encoder, and direct exporter; only endpoint and tailnet admission differ. Exports are chunked below the collector's configured body limit (historically ~3.5 MB).
- **BUILD.BUCK.OBS.ING-R02 Identity independence (refines BUILD.BUCK.OBS-R04):** The
  job trace ID and attempt-close pipeline link trace derive from 01's
  pre-delivery identity. Task and command spans and seeded Buck critical
  views nest in one job trace; unseeded commands use 04's independent
  critical trace. The Buck full view has a deterministic linked trace ID.
  No manifest digest or backend search mints an ID; the producer already
  has its canonical job key, while finalizer/reporter reconstruct it from
  Jobs API metadata before applying the same hash.
- **BUILD.BUCK.OBS.ING-R03 Local retry (refines BUILD.BUCK.OBS-R04):** Write exportable batches to a local retry spool before sending, retain unacknowledged batches across exporter failure, and retry them without changing the build's result. Acknowledged batches may leave the spool; there is no remote raw-evidence archive or cross-host recovery promise.
- **BUILD.BUCK.OBS.ING-R04 Retention (refines BUILD.BUCK.OBS-R06):** Tempo retains traces for 30 days; long-term trends use bounded Mimir metrics. Native evidence survives only according to the producing host's spool lifecycle.
- **BUILD.BUCK.OBS.ING-R05 Provider-neutral tagging (refines BUILD.BUCK.OBS-R08):** Trace/resource attributes include available `cicd.*`, `vcs.*`, `buck2.vcs.merge.revision`, `vcs.provider.name`, and `buck2.vcs.change.is_fork` facts; run IDs and attempts are string-valued. High-cardinality identifiers never become metric labels.
- **BUILD.BUCK.OBS.ING-R06 Search-independent links:** The producer can calculate deterministic job/trace identifiers and Grafana Explore links before export. Delayed Tempo indexing cannot delay publication or cause guessed trace IDs.
- **BUILD.BUCK.OBS.ING-R07 Deployment boundary:** effect-utils owns capture, local spool, conversion and OTLP exporter. Dotfiles owns dev3 Alloy :4318, its tailnet ACL, Tempo/Mimir routing and retention. No `buck2-evidence` upload/serve service, two-socket admission pair, SQLite index, or resolver participates.
- **BUILD.BUCK.OBS.ING-R08 Job-end burst:** On trusted same-repository PRs, main pushes, and tailnet-reachable local runs, the completed job's task and command spans join its single job trace after build and before one direct OTLP burst. CI joins the tailnet only after build work. Forks and offline local runs spool without export; retries happen from the local spool.
- **BUILD.BUCK.OBS.ING-R09 Failure visibility:** An OTLP 2xx response with nonzero
  partial-success rejected spans or data points does not acknowledge the
  chunk; the whole chunk remains retryable and the rejected count is
  reported. Resends preserve deterministic span IDs but may duplicate
  already accepted data. OTLP success is not proof of Tempo persistence;
  no by-ID repair or `missing_spans` state is required.
- **BUILD.BUCK.OBS.ING-R10 Attempt closure:** The CI finalizer sends one pipeline
  link trace at attempt close, linking uniquely identified jobs that started
  in the closing attempt without claiming their roots were exported.
  It neither waits for records to be ingested nor synthesizes missing-job
  spans; an undeliverable link trace follows the same spool/retry policy.
