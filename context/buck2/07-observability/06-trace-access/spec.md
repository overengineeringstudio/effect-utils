# Trace Access Spec

This document specifies the PR jobs-and-steps waterfall, compact job report, and deterministic Grafana trace links. It builds on [requirements.md](./requirements.md); [01](../01-run-identity/spec.md) owns trace identities and [05](../05-otlp-delivery/spec.md) owns delivery to Tempo.

## Status

Draft.

## Scope

**Defines:** Jobs API data selection, baseline math, V2 D2 T2 PR presentation, immutable public PNG publication, jobs-only Mermaid fallback, and Grafana Explore URLs.

**Does not define:** Tempo storage, trace delivery, Grafana deployment, task-level Tempo reads, or GitHub workflow generation.

## Data Flow

```text
PR attempt close (after build jobs settle)
  ├─ Jobs API: latest execution of each job (all pages)  -> jobs + step timeline
  ├─ Workflow Runs API: newest completed successful main pushes (at most 20)
  │    └─ Jobs API: each selected run's jobs            -> p50 baseline
  └─ 01 deterministic job trace IDs + Grafana base URL -> Explore links
       -> light/dark SVG -> pinned resvg + fonts -> public GitBucket CAS PNG pair
       -> workflow-report sticky PR comment (compact table; Mermaid on image failure)
```

The workflow-report generator uses the workflow's GitHub token to list
successful main workflow runs and read their jobs. The workflow-runs API
supplies only candidate IDs, conclusion and branch; the Jobs API is the
sole source of current and baseline job timings. The fleet host does not
call GitHub; CI does not call Tempo. The finalizer can run after dependent
jobs even if one failed or was cancelled. It excludes itself from build
rows and the baseline.

## Job Facts

Read the current workflow run's jobs once with `filter=all`, following
pagination, and report the latest attempt's rows. Use each job's execution
attempt ([01](../01-run-identity/spec.md)) for its trace identity and
attempt-close link, not its `run_attempt`, which carried-over rows share.
Map each Jobs API `name` through
[01's finite generated-workflow name mapping](../01-run-identity/spec.md)
to its job identifier and named matrix dimensions before deriving the
canonical `K` bytes. Reject duplicate or unrecognized names rather than
assigning two jobs one trace. Show an unmatched provider job name without
baseline or trace link; store no provider job ID in trace attributes.

| Column    | Rule                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Job       | Markdown-escaped job key/name                                                                                                                                |
| Status    | provider status plus conclusion (`success`, `failure`, `cancelled`, `skipped`, or unfinished)                                                                |
| Wall time | `completed_at - started_at` when both exist; otherwise `unavailable`                                                                                         |
| Delta     | `duration unavailable` without valid job timing; otherwise `no main baseline` at `n=0`; otherwise signed duration minus p50 in seconds and percent, with `n` |
| Trace     | Grafana Explore link if adapter identity, devenv resolution, and export succeed; else `not instrumented` (completed) or `unavailable` (skipped/unfinished)   |

A failed PR job still has its observed duration and delta when timings
exist; its row keeps `failure`. Skipped, never-started, cancelled without
end time, or unfinished jobs have no delta: show `duration unavailable`
even when a valid baseline exists. The table uses the attempt the comment
describes, not the latest attempt of a different run.

Step `started_at` and `completed_at` fields are optional and nullable so historical
Jobs API fixtures and persisted reports remain readable. Only finite, ordered
step intervals are shown; clamp them to the parent job's observed window.
Skipped steps have no bar. A started unfinished step without a completion time
extends to report generation time, bounded by its job window; a completed step
with no completion timestamp has unavailable timing rather than an invented
duration. These are provider steps, not devenv task spans or task annotations.

The Jobs API export step can succeed without emitting a root when the adapter
finds no pipeline identity or resolved devenv binary. The reporter checks all
three named adapter steps rather than mistaking an always-run no-op export for
proof of a trace; this gate does not prove Tempo has indexed the trace.

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

Each GitHub API GET has a 20-second timeout and retries transient 5xx, 429, network failures and timeouts with at most three bounded exponential backoffs, respecting `Retry-After` when it fits the retry budget. Collection has a 90-second deadline: on expiry, workflow metadata or main-run listing failure, render the current jobs with an explicit baseline-incomplete reason and the samples already collected; if a selected main run's jobs remain unavailable, omit its samples, retain its ID in the skipped-run audit and report the reduced `n`.

## V2 D2 T2 Presentation

This presentation realizes BUCK.OBS.ACCESS-R01–R04 and R07 without a Tempo read.

```text
Jobs API job windows + optional step windows
  -> chronological nested waterfall -> baked light PNG + baked dark PNG
  -> compact table (failures / five slowest / material regressions)
     └─ collapsed remaining job rows
Image unavailable -> jobs-only Mermaid gantt + the same table
```

### Jobs and Steps Waterfall

The image uses one chronological attempt-level axis, visible job and step
durations, a status legend, and nested step labels. The longest observed job
window is marked **Slowest**; this is not a dependency-DAG critical path.
Unfinished windows remain explicitly unfinished and are bounded by collection
time, not treated as completed durations.

Partial reruns retain carried-over jobs from their actual execution attempts.
Every job shows its execution-attempt badge; older rows are marked carried over.
Idle gaps greater than five minutes are compressed into visible dashed breaks
with the omitted wall duration stated. Axis labels remain elapsed time from
the earliest observed job start, so the piecewise horizontal scale does not
conceal rerun chronology.

Each job shows at most four timed steps: non-success steps first, then the
longest remaining successful steps, rendered in start-time order. Disclose
the number of other timed steps omitted per job. Bound the full image to 300
timeline rows and disclose any additional omissions; the job table remains
independent of this raster bound. Skipped or untimed jobs remain visible with
unavailable timing, not zero-length success bars. Escape all SVG labels as XML.

The raster is 960 pixels wide with 16-pixel body type: at a 770-pixel GitHub
comment width, labels occupy 12.83 CSS pixels (13.03 at 781.98 pixels).
Keep 20-pixel timeline rows, rather than enlarging the whole image or doubling
the raster resolution; the 300-row image remains 6,186 pixels high.
The label column ends before the plot at x=320, abbreviates labels after
32 characters, and clips unusually wide glyphs; full names remain in SVG
tooltips and the independent job table. The plot ends at x=740, leaving
208 pixels for right-aligned durations and execution-attempt badges.
Header, axis and footer bands reserve clearance for the larger type in both
baked palettes. No explicit HTML width or rasterizer change is needed.

### Compact Job Table

Keep failed jobs, the five slowest jobs with measured completed wall durations,
and jobs regressed by both at least 30 seconds and at least 25 percent against
a positive main p50 inline. Put every other job in a collapsed details block.
The selection does not change baseline eligibility, status, trace-link gating,
or the full set of rows. Escape externally supplied labels for Markdown and
HTML; a missing baseline never becomes a fabricated regression.

### Public Immutable Images and Failure Path

Rasterize separate baked light and dark SVG palettes with the repository-pinned
resvg and DejaVu font closure. Upload PNGs to the existing public GitBucket
content-addressed store; comments reference immutable public HTTPS URLs under
`gitbucket.schickling.dev`, not a mutable asset branch or authenticated endpoint.
Use a theme-aware picture pair only after both uploads and URL validation
succeed. PNGs must be nonempty and at most 5 MiB each; SVG generation and
rasterization have bounded execution times. The adapter's OIDC token request
and GitBucket exchange each have an 8-second limit; the upload request has a
40-second limit because GitBucket commits to its GitHub-backed store. Each
adapter invocation is bounded to 60 seconds; a partial pair is not attached.

The Pipeline traces job explicitly grants `id-token: write` in its existing
permission override; the existing workflow-level Tailscale OIDC grant is unchanged.
The adapter requests GitHub's ID token with audience
`https://gitbucket.schickling.dev/api/auth/github-actions`, exchanges it at that
endpoint, then uploads with explicit public consent. The server verifies GitHub
JWKS signatures, issuer, audience, expiry, and `GITBUCKET_ACTIONS_POLICIES_JSON`.
Repository names and immutable repository/owner IDs, PR event/ref and CI workflow
pattern must match the configured allowlist.
The minted credential has distinct upload-only type, no role or refresh token,
a lifetime of at most five minutes, and fixed `image/png`, 5 MiB,
`requirePublicOk` scope. Existing access and refresh verifiers reject it.

The report has no account-scoped publication credential or SSH authentication
path. A successful adapter invocation emits only its validated public URL on
stdout and a fixed OIDC authentication marker on stderr; the reporter exposes
that marker as a controlled per-theme success line. An optional executable-path
override receives one PNG path and returns one public URL, never arbitrary shell
text.

Missing credentials, rasterization failure, upload failure, or invalid URLs
leave the original usable report intact and select the deterministic jobs-only
Mermaid fallback. Failures emit controlled stage diagnostics without raw
secret-bearing stderr: an upload failure may append only the adapter's
sanitized `<oidc|exchange|upload|url> <http NNN|exit N>` reason, never
response bodies, tokens or raw authentication diagnostics. Dry-run never uploads.
Image handling adds no Tempo
reads, task spans, task annotations, or per-build-job workflow steps.

### Jobs-Only Mermaid Fallback

Render a Mermaid `gantt` inside a collapsed details block when images are
unavailable and at least one job has a start time. Each completed bar spans
`started_at` to `completed_at`; an unfinished bar extends to report generation
time with an unfinished label. Skipped and never-started jobs appear in the
table only. Sanitize external job names for Mermaid syntax and state how many
jobs lack bars so absence is not read as zero duration. The fallback contains
no step or task bars.

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

The existing sticky comment replaces its Pipeline traces entry for the current
run attempt. The ci-tools workflow-report renderer shows summary counts, the
light/dark waterfall pair or jobs-only Mermaid fallback, compact inline job
rows and collapsed remaining rows, baseline notes (`n` and selected and skipped
run IDs), and a statement that task-level durations are not included. The
reporter adds no per-job workflow outputs or YAML to build jobs. Keep the 60,000
character comment-body guard: disclose row/timeline omissions if necessary and
retain a usable bounded report. Embedded managed state keeps identity metadata,
not duplicate timeline/image/table payloads. Never embed GitHub tokens, SSH
keys, fleet endpoints, or raw Tempo query results. Missing current-run jobs
render an explicit failure note and leave the Buck result unchanged; missing
baseline jobs do not suppress the table. Forks keep the workflow's no-write guard.

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
- A completed job whose adapter identity, devenv resolution, or export step
  was absent or unsuccessful has no trace ID/link, including when the export
  step itself succeeded after returning early.
- The timing collector reads only GitHub Actions workflow-run metadata and
  Jobs API facts, with no Tempo, SQLite, resolver, or artifact reads.
- A light/dark PNG pair is attached only after both public GitBucket uploads
  validate; absent credentials, an unsafe URL, or a failed second upload keeps
  the complete jobs-only fallback. Dry-run performs no image upload.
- Carried-over rows keep execution-attempt badges; compressed idle gaps and
  omitted timed steps are disclosed, and Slowest never implies a DAG critical path.
- Compact selection preserves all other rows in collapsed details; the existing
  body limit still bounds both image and fallback comments.
- Historical evidence: [PR access prototype](./.experiments/2026-09-25-pr-trace-access.md), [page variants](./.experiments/2026-09-26-pr-page-variants.md), and amended decisions [0001](./.decisions/0001-resolver-and-ci-links.md), [0002](./.decisions/0002-review-page-and-baseline.md), [0003](./.decisions/0003-versioned-agent-contract.md).

## Open Design Questions

- **DQ1 Restricted GitBucket publisher authority — resolved:** The deployed
  GitHub Actions OIDC exchange verifies GitHub's signature, issuer, service
  audience, expiry and configured repository names plus immutable repository/
  owner IDs, event/ref/workflow constraints. It mints only short-lived PNG
  upload tokens with MIME/size/public-consent enforcement and no access role or
  refresh capability. The CAS remains public with no private namespace.
  [PR 1584's first live proof](https://github.com/overengineeringstudio/effect-utils/actions/runs/37158430402/job/111311680936)
  logged both themes uploaded through OIDC; the
  [picture comment](https://github.com/overengineeringstudio/effect-utils/pull/1584#issuecomment-5969239780)
  referenced two URLs verified as `200 image/png`, without publication warnings.
  The report's SSH branch and credential references are removed. Retired stored
  credentials are an operator cleanup action, not report inputs. Tracking:
  [root open questions](../../open-questions.md#oq4-how-is-the-gitbucket-waterfall-publisher-restricted-to-public-png-publication).
