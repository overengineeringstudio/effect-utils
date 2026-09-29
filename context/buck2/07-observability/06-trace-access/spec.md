# Trace Access Spec

This document specifies the PR job report and deterministic Grafana trace links. It builds on [requirements.md](./requirements.md); [01](../01-run-identity/spec.md) owns trace identities and [05](../05-otlp-delivery/spec.md) owns delivery to Tempo.

## Status

Draft.

## Scope

**Defines:** Jobs API data selection, baseline math, PR comment contents, gantt semantics, and Grafana Explore URLs.

**Does not define:** Tempo storage, trace delivery, Grafana deployment, task-level Tempo reads, or GitHub workflow generation.

## Data Flow

```text
PR attempt close (after build jobs settle)
  ├─ GET current run jobs (all pages)                  -> job table + gantt
  ├─ GET latest successful main CI runs; select 7 samples per job key
  │    └─ GET jobs for candidate runs                 -> p50 baseline
  └─ 01 deterministic job trace IDs + Grafana base URL -> Explore links
       -> workflow-report sticky PR comment
```

The workflow-report generator runs in CI and uses the workflow's GitHub token to read Actions job metadata and update the existing sticky comment. The fleet host does not call GitHub; CI does not call Tempo. The finalizer can run after dependent jobs even if one failed or was cancelled. It excludes itself from the build-job rows and the baseline.

## Job Facts

Read the current workflow run's jobs for its **current attempt**, following
pagination. The GitHub adapter maps the Jobs API `name` through the same
generated job-name rule used by the existing producer identity step's
`JOB_KEY` and `MATRIX_VALUE` (01); a matrix runner value is part of the key.
Reject duplicate canonical keys rather than assigning two jobs one trace.
If the adapter cannot reconstruct a unique key, show the provider job name
as an unmatched row and omit both baseline and trace link rather than
guessing. Store no provider job ID in trace attributes.

| Column    | Rule                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| Job       | Markdown-escaped job key/name                                                                                  |
| Status    | provider status plus conclusion (`success`, `failure`, `cancelled`, `skipped`, or unfinished)                  |
| Wall time | `completed_at - started_at` when both exist; otherwise `unavailable`                                           |
| Delta     | job wall time minus baseline p50, signed seconds and percentage; `baseline unavailable` without a valid sample |
| Trace     | deterministic Grafana Explore link for executed jobs, if 01 identity is available                              |

A failed PR job still has its observed duration and delta when timings exist; its row keeps `failure`. Skipped or never-started jobs have no duration or delta. The table uses the attempt the comment describes, not the latest attempt of a different run.

## Main Baseline

Select candidate workflow runs on the main branch from the same workflow and repository, newest first. A candidate is admissible only when the workflow run concluded `success` and its job has conclusion `success` with both timestamps. For every PR job key, walk candidates until seven admissible job samples or no more candidates; retain run IDs and sample count for audit. Compute p50 as the median of the sampled wall durations, averaging the two middle values when seven is unavailable and the sample count is even. Report the actual `n`; with `n=0`, do not calculate a delta. The baseline compares like-for-like matrix-qualified job keys, never provider job display order or run number alone. Main runs remain the source even after trace data expires from Tempo.

## Gantt

Render a Mermaid `gantt` inside a collapsed `<details>` block in the comment when at least one job has a start time. Its axis starts at the earliest observed job start in the attempt. Each completed job bar spans `started_at` to `completed_at`; an unfinished job extends to the report generation time with an `unfinished` label; skipped and never-started jobs appear in the table only. Bar labels contain job key and conclusion; external names are sanitized for Mermaid syntax. Show a textual note for omitted rows so a missing bar is not read as zero duration.

## Deterministic Grafana Links

For each executed job with a 01 job trace ID, construct:

```text
<GRAFANA_BASE_URL>/explore?schemaVersion=1&orgId=1&panes=<percent-encoded JSON>
{"a":{"datasource":{"type":"tempo","uid":"tempo"},
      "queries":[{"refId":"A","datasource":{"type":"tempo","uid":"tempo"},
                  "queryType":"traceql","query":"<32-lower-hex job trace ID>"}],
      "range":{"from":"<started_at-15m epoch ms>","to":"<completed_at+60m epoch ms>"}}}
```

`GRAFANA_BASE_URL` is configured without a trailing slash, never inferred from runner hostnames. The trace ID must be exactly 32 lowercase hexadecimal characters; malformed or missing identity means no link. JSON is serialized with the key order above and percent-encoded as a URI component. For an unfinished job, use the report time as `completed_at`. The link is stable for fixed job facts. It may open empty if delivery failed, Tempo has not indexed the trace yet, the viewer lacks tailnet access, or retention expired; the comment wording does not claim trace completeness. The pipeline-run link trace from 01 can be listed with the attempt-level window, but it is not required for per-job rows.

## Comment Contract

The existing sticky comment gets one Buck2 observability section, replacing the section for the same run attempt. The ci-tools workflow-report table renderer produces the job table; the reporter adds no per-job workflow outputs or other YAML to build jobs. The section shows summary counts, the job table, the collapsed gantt, baseline notes (`n` and selected run IDs), and a statement that task-level durations are not included. It never embeds GitHub tokens, fleet endpoints, or raw Tempo query results. A missing Jobs API response renders an explicit failure note and leaves the Buck result unchanged. Forks keep the workflow's no-write guard.

## Conformance

- Given current jobs with success, failure, cancelled, skipped, and unfinished states, the table preserves each status and never emits a zero-duration success.
- Given nine successful, one failed, and one cancelled main run, the baseline takes the latest seven admissible successes for the matching job key and reports p50 and `n=7`.
- A job absent from every admissible main run reports `baseline unavailable`; a finalizer job never appears as a build row.
- The same job facts and trace identity produce the exact same Grafana URL; malformed IDs produce no URL; an unindexed trace remains an Explore link, not a pending resolver state.
- The comment generator performs Jobs API and comment operations only: no Tempo, SQLite, resolver, artifact download, or upload request.
- Historical evidence: [PR access prototype](./.experiments/2026-09-25-pr-trace-access.md), [page variants](./.experiments/2026-09-26-pr-page-variants.md), and amended decisions [0001](./.decisions/0001-resolver-and-ci-links.md), [0002](./.decisions/0002-review-page-and-baseline.md), [0003](./.decisions/0003-versioned-agent-contract.md).
