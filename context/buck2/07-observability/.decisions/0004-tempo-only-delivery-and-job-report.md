# 0004 Tempo-Only Delivery and Job Report

Status: accepted

Accepted 2026-09-28 (Johannes, q58–q63). Amends BUCK.OBS-R01, R04, R06 and earlier decisions q37/q42. This is a design record; the current contract lives in the requirements and child specs.

## Context

The previous record-first design made an evidence upload service responsible
for conversion, archiving, and run closure. Its costs became measurable once
the service ran beside Tempo and the Buck cache on dev3.

## Evidence and Argument

The round-3 transport bakeoff (`round3/ReplayTrigger/experiment.md`,
2026-09-25)
favored a sealed run record: direct OTLP lacked auth headers and an outage
spool, while records enabled re-ingest and archival. A tailnet ACL grant to
dev3 Alloy port 4318 removes the header requirement (as for `tag:pimuseum` and
`tag:molty-prod`). The evidence service, Tempo, and Buck cache share dev3,
so another dev3 service does not change host availability. Operating it added
a SQLite queue, an archive, reconciliation, a two-hour settle window, and
ACL/Serve/port maintenance. A local spool supplies outage retry.

A Tempo spaced-burst repro (grafana/tempo#8002) lost 37 of 6,255 spans after
two minutes idle when the trace was read between bursts; the single-burst
control lost none. The round-5 comment-source bakeoff
(`round5/CommentDataSource/experiment.md`, 2026-09-28)
measured nine Jobs API calls for a current run and seven baselines. Per-job
outputs pushed workflow YAML to an estimated 499,631/500,000 bytes and
collide for matrix jobs. Unrestricted Tempo read exposed 37 fleet services;
seven matching main-run task baselines were not demonstrated.

## Options

| Choice | Benefit | Cost / outcome |
| --- | --- | --- |
| Record-first upload and archived raw evidence | Re-ingest, reconcile, one-year history | Rejected: extra service, queue, archive, settle and deployment cost without added dev3 availability |
| Direct OTLP plus raw archive | Shorter export path and re-ingest inputs | Rejected: two sinks and a service for the archive |
| Direct OTLP with local retry spool | Same path locally and in CI; no evidence service | Accepted: history ends at Tempo's 30 days; regeneration only while the spool survives |
| One pipeline-wide trace | One cross-job waterfall | Rejected: spaced-burst loss can be permanent without archive |
| One trace per job, linked at close | One burst per job; searchable by pipeline run ID | Accepted: no single cross-job waterfall |
| Job outputs or unrestricted Tempo read for the comment | Task-level columns | Rejected: workflow size/matrix collision or fleet-wide trace exposure |
| Jobs API-only report | Job timings and baseline without Tempo read or YAML growth | Accepted: task-level columns deferred |

## Decision

Same-repo PR and main CI jobs export OTLP directly to dev3 Alloy over a tailnet ACL grant; `CI_EVIDENCE_MODE=upload` selects that mode. Local runs use the same collector path. Forks only write the local spool, never export. Tailnet join follows build work and immediately precedes export (#1477). A failed export leaves retryable telemetry in the spool and never changes the build result. There is no run record upload, evidence service, SQLite queue, reconcile, resolver, or raw archive. Tempo retains traces for 30 days and Mimir holds bounded metrics. BUCK.OBS-R01, R04, and R06 are amended accordingly.

Each job/task run exports one trace once at job end. Its root carries `cicd.pipeline.run.id`; the attempt-close step emits a small Pipeline Trace whose root links to every job trace. The PR comment uses only GitHub Actions Jobs API data: job status and wall time, a delta against the median of the last seven successful main runs for the same job, a collapsed Mermaid job gantt, and deterministic Grafana links derived from pipeline run ID and task key. The report is rendered with the ci-tools workflow-report table. It adds no per-job workflow outputs or new YAML. A future isolated Tempo buck2 tenant with an authenticated, restricted read proxy may support task-level columns; it is not a CI read grant to fleet Tempo.

## Consequences

Lost or expired spools cannot be reconstructed from Tempo; post-retention re-ingest is unavailable. A job trace has no whole-run waterfall, so the Jobs API gantt is the run-level view. The reporter can show skipped/cancelled jobs but cannot claim Buck action critical paths or task-level baselines from the Jobs API. The dotfiles fleet config owns Alloy, Tempo, the tailnet ACL, and retention; effect-utils owns conversion, retry, trace identity, and comment rendering.
