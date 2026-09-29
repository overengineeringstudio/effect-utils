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
  ├─ Jobs API: current attempt jobs (all pages)         -> job table + gantt
  ├─ Workflow Runs API: newest completed successful main pushes (at most 20)
  │    └─ Jobs API: each selected run's jobs            -> p50 baseline
  └─ 01 deterministic job trace IDs + Grafana base URL -> Explore links
       -> workflow-report sticky PR comment
```

The workflow-report generator uses the workflow's GitHub token to list
successful main workflow runs and read their jobs. The workflow-runs API
supplies only candidate IDs, conclusion and branch; the Jobs API is the
sole source of current and baseline job timings. The fleet host does not
call GitHub; CI does not call Tempo. The finalizer can run after dependent
jobs even if one failed or was cancelled. It excludes itself from build
rows and the baseline.

## Job Facts

Read the current workflow run's jobs for its **current attempt**, following
pagination and filtering `run_attempt`. Map each Jobs API `name` through
[01's finite generated-workflow name mapping](../01-run-identity/spec.md)
to its job identifier and named matrix dimensions before deriving the
canonical `K` bytes. Reject duplicate or unrecognized names rather than
assigning two jobs one trace. Show an unmatched provider job name without
baseline or trace link; store no provider job ID in trace attributes.

| Column    | Rule                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job       | Markdown-escaped job key/name                                                                                                                                             |
| Status    | provider status plus conclusion (`success`, `failure`, `cancelled`, `skipped`, or unfinished)                                                                             |
| Wall time | `completed_at - started_at` when both exist; otherwise `unavailable`                                                                                                      |
| Delta     | `duration unavailable` without valid job timing; otherwise `no main baseline` at `n=0`; otherwise signed duration minus p50 in seconds and percent, with `n` |
| Trace     | deterministic Grafana Explore link for executed jobs, if 01 identity is available                                                                                         |

A failed PR job still has its observed duration and delta when timings
exist; its row keeps `failure`. Skipped, never-started, cancelled without
end time, or unfinished jobs have no delta: show `duration unavailable`
even when a valid baseline exists. The table uses the attempt the comment
describes, not the latest attempt of a different run.

## Main Baseline

List runs for this repository and workflow on `main` using the workflow-runs
API (`branch=main`, `event=push`), following pagination and sorting newest
first. Keep only completed runs with conclusion `success`; inspect at most
the latest **20** such runs, even if some PR jobs are absent from main. For
each PR job key, fetch selected runs' Jobs API pages in order until seven
jobs with matching canonical keys, `success` conclusions and both timestamps
are found, or the 20-run selection is exhausted. Do not fetch older runs
solely to fill a sparse or PR-only key. The cap bounds work for PR-only jobs
without concealing sparse data: report the actual sample count `n` even
when below seven. Retain selected run IDs for audit. Compute p50 as the
median of the sampled wall durations, averaging the two middle values if
the sample count is even. At `n=0`, display `no main baseline` instead
of a fabricated delta. Compare like-for-like matrix-qualified keys rather
than provider display order or run number. Main runs remain the source
even after Tempo retention.

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

- Current jobs with success, failure, cancelled, skipped, and unfinished
  states preserve status and never emit a zero-duration success. A job with
  no completion timestamp reports `duration unavailable` even when its
  baseline has seven valid samples.
- Among nine successful, one failed and one cancelled main run, enumerate
  candidates through the workflow-runs API, then select the latest seven
  admissible same-key Jobs API durations and report p50 and `n=7`.
- A job absent from all 20 selected successful main runs reports `no main
  baseline`; a finalizer job never appears as a build row. The collector
  makes no more than 20 baseline Jobs API run requests for this selection.
- The same job facts and trace identity produce the exact same Grafana URL;
  malformed IDs produce no URL; an unindexed trace remains an Explore link.
- The comment generator reads only GitHub Actions workflow-run metadata and
  Jobs API facts, with no Tempo, SQLite, resolver or artifact requests.
- Historical evidence: [PR access prototype](./.experiments/2026-09-25-pr-trace-access.md), [page variants](./.experiments/2026-09-26-pr-page-variants.md), and amended decisions [0001](./.decisions/0001-resolver-and-ci-links.md), [0002](./.decisions/0002-review-page-and-baseline.md), [0003](./.decisions/0003-versioned-agent-contract.md).
