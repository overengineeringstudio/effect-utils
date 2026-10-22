# Trace Views Spec

This document specifies view rules, cap mechanics, and command summaries.
It builds on [requirements.md](./requirements.md), consumes the local span
model from [03](../03-event-log-adapter/spec.md), and sends completed traces
through the direct export path in [05](../05-otlp-delivery/spec.md).

## Status

Draft.

## Scope

**Defines:** both stored views, threshold escalation, cap behavior, command
summaries, bounded metrics, and trace lookup fields.

**Does not define:** direct OTLP transport (05) or adapter decoding (03).

## View Selection

```text
local span model (salted ids, daemon waits)
  ├─ critical view (default; seeded: job trace; unseeded: command trace)
  │    keep: roots + buck2.command
  │          critical-path actions + stage children
  │          spans >= threshold (default 1 s) + ancestors
  │          daemon-wait spans
  │    escalate threshold to span count <= 1,200
  │    stamp: dropped_children; exact command summaries
  └─ full view (separate deterministic trace; link only if caller exists)
       keep: every span
```

Both views derive deterministically from the same local event log and
sidecar context. With a valid caller span, the critical view is parented
beneath its task and command spans in the job trace; a local task run has
a job-equivalent trace. The full-view root links to the command span.
Without a valid caller context (ID-R07), the adapter exports the critical
view as an independent root rather than inventing a missing job/task span;
the separate full-view root has no caller link.

For independent views, parse the Buck trace UUID as 16 bytes and format it
as exactly 32 lowercase hexadecimal characters without hyphens. The
critical/full trace IDs are the first 16 bytes of
`SHA-256(UTF-8(canonical UUID + ":critical"))` and
`SHA-256(UTF-8(canonical UUID + ":full"))`, respectively; if the 16 bytes
are all zero, rehash the original input with an appended `u32be(counter)`
starting at 1. The same full-view rule applies to seeded commands; a seeded
critical view instead inherits the caller job trace ID. Job roots carry
`cicd.pipeline.run.id` for run lookup. Eligible completed views export to
the configured collector under consumer admission; forks keep only the local spool. Neither view needs an archived
record or read-time transformation.

Measured shape on the largest cold-CI command (12,622 spans): full view
12.70 MB; the 1 s rule yields a **pre-escalation candidate** of ≈ 1,113–1,225
spans / ~1.6–1.8 MB (91–92% reduction) keeping 15 of 21 critical-path action
names and 543 actions — the cap then escalates the threshold to land at
≤ 1,200 stored spans (the span-cap benchmark's stored result: exactly 1,200 /
1.81 MB); at corpus scale, 66,948 spans → 5,870 (15 CI logs). The native
event log was 711 KB for that command; it remains local conversion evidence,
not a remotely retained forensic archive.

## Why 1,200

| Evidence             | Numbers                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trace fetch (median) | 126 ms @300 · 143 @600 · 224 @1,200 · 316 @2,500 · 566 @5,000 · 1,079 @full                                                                           |
| Grafana render       | cap-insensitive (81–119 MB heap, ~1.1–1.7 s visible); full adds ~0.5 s / ~15 MB                                                                       |
| Vista trace islands  | one page: 1.13 GB cumulative after 1,200; full pushes it to 1.39 GB (earlier evidence: 21 k spans crashed a 3 GB browser)                             |
| Breadth              | 600 keeps 10/21 critical names + 256 actions; 1,200 keeps 15/21 + 543; 2,500 adds little for +92% bytes (poor knee); 5,000 is an opt-in forensic tier |
| Exactness            | command summaries make the cache ratio exact at every cap (603/2,160 = 27.92% retained as attributes)                                                 |

## Command Summary Attributes

Every view's command span carries `buck2.action_count`,
`buck2.cache_hit_count`, `buck2.remote_cache_hit_count`,
`buck2.local_cache_hit_count`, `buck2.critical_path_action_count` (plus
subcommand), so "what was the cache-hit ratio" never depends on child
retention.

All three hit counts come from one execution-kind classification over the
decoded action model, before view selection or the span cap:

| Attribute                      | Execution kinds                         |
| ------------------------------ | --------------------------------------- |
| `buck2.remote_cache_hit_count` | `action_cache`, `remote_dep_file_cache` |
| `buck2.local_cache_hit_count`  | `local_action_cache`                    |
| `buck2.cache_hit_count`        | sum of the two rows above               |

Remote execution is not a hit. Only an action's first end is classified;
an action without an end counts toward `buck2.action_count` but not as a hit.
The counts are exact for the decoded log; a truncated or corrupt log keeps the
adapter's coverage limits. `buck2.remote_cache_hit_count` reports hits from any
remote action or dependency-file cache: the command span does not identify the
cache server or trust tier.

Both views carry the summary, so a per-host or per-command aggregate selects one
view (`span.buck2.trace.view = "critical"`) and divides summed hit counts by
summed action counts rather than averaging per-command ratios.

## Trace Lookup

The deterministic job trace ID derives from the run ID and canonical
matrix-qualified key ([01](../01-run-identity/spec.md)); every job root has
`cicd.pipeline.run.id`. A seeded command's critical view shares that job
trace while its full-view root links to the command span. Without context,
critical and full roots use the independent IDs above and cannot be found
by an absent pipeline-run ID. Grafana links can use derived IDs without a
resolver; neither a link nor a Tempo query proves that export succeeded.

## Metrics

Local conversion emits metrics alongside the completed traces. Canonical
names are OTel dotted names. Prometheus translation replaces dots with
underscores; suffix-enabled translation additionally adds `_seconds` to
seconds-valued histograms and `_total` to counters (shown below). Consumers
must inspect their backend's translation policy: suffix-disabled OTLP ingest
exposes `buck2_action_queue_duration_{bucket,sum,count}`, for example.

| Canonical (OTel)                      | Prometheus-compatible                     | Type      | Labels (closed enums)               |
| ------------------------------------- | ----------------------------------------- | --------- | ----------------------------------- |
| `buck2.command.duration` (s)          | `buck2_command_duration_seconds`          | histogram | subcommand                          |
| `buck2.critical_path.duration` (s)    | `buck2_critical_path_duration_seconds`    | histogram | subcommand                          |
| `buck2.action.count`                  | `buck2_action_count_total`                | counter   | category, execution_kind, cache_hit |
| `buck2.action.execution.duration` (s) | `buck2_action_execution_duration_seconds` | histogram | category                            |
| `buck2.action.queue.duration` (s)     | `buck2_action_queue_duration_seconds`     | histogram | category                            |

These bounded dimensions support long-term trends independently of consumer-selected
trace retention. No target, digest, run id, trace id, or host point label
is emitted. The resource carries the writer's `host.name`, host-derived
`service.instance.id`, `os.type`, and `host.arch`, shared with traces; see the
[adapter resource and timing contract](../03-event-log-adapter/spec.md#producer-metrics).
Backends may promote bounded host resource attributes to labels under their
own cardinality policy; resource presence alone does not guarantee promotion.

### Cache lane evidence join

```text
producing workflows → created-bounded run pages → UTC-day/lane run selection
  → artifacts per selected run → strict evidence → warm99 join → daily gauges
                                                              ├─ OTLP metric spool
                                                              └─ Prometheus text
```

The repository-owned `buck2-cache-join` entrypoint joins retained GitHub CI
action evidence independently of trace retention. Its canonical metric names
belong to the repository-local `buck2.cache` namespace; lowercase dotted OTel
names translate to Prometheus by replacing dots with underscores, with no
counter suffix because these are gauges.

Run `bun genie/ci-scripts/buck2-cache-join-cli.ts --repo owner/name --since 24h`
locally with `GITHUB_TOKEN` in the environment (Actions read access). Output
defaults to Prometheus text; `--format json` emits the same counts as JSON.
`--until` accepts an ISO-8601 instant or duration; `--previous-utc-day` selects
the scheduled day window instead of `--since`/`--until`. Discovery lists runs
only for the evidence-producing workflows `ci.yml`, `empirical-proofs.yml`,
`storybook-plays.yml`, and `storybook-preview-build.yml`, using
`GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs` with a bounded
`created` filter and pagination. The requested run `created_at` interval is
half-open; inclusive API bounds are filtered back to that exact interval.
Discovery never uses the repository artifact listing endpoint. The
`compiled-products.yml` workflow is omitted because its evidence producers
are deliberately disabled.

Runs are grouped by UTC creation day and discovered lane cohort. Every
`main-writer` run is selected. The `merge_group` cohort selects at most 50
runs per UTC day, ordered by numeric run ID; it supplies both writer evidence
and the R09 reader lane. Each `main-reader` and `pr` cohort selects at most 25
runs per UTC day, ordered by ascending `created_at` then numeric run ID.
For a cohort of size `L` and limit `N`, select all if `L <= N`; otherwise select
indices `floor(i * (L - 1) / (N - 1))` for `i = 0..N-1`.
This deterministic, evenly spaced sample includes both endpoints; a
one-element sample selects the first run. Sampling is by run, not artifact or
job: the `ci.yml` main-writer cohort also retains its reader jobs. Discovered
cohorts control selection, never strict action eligibility.

Only after run selection does collection paginate
`GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts` for each selected
run. Expired evidence artifacts are not downloaded and contribute evidence
gaps. Known artifact names for deliberately disabled lanes are skipped without
a gap; unknown lane names are downloaded and only dropped after strict
evidence decoding establishes a deliberately unassigned lane. Artifact names
never replace decoded evidence as the eligibility authority.

Collection caps the window at 31 days, 1,000 observed runs, 2,000 selected
artifacts, 80 MiB per ZIP and 2 GiB of artifact bytes received overall. The
aggregate byte budget is charged as chunks stream, including partial failed
attempts and retries, and fails immediately on crossing the cap. Per-response
byte limits remain independent. ZIP inspection uses platform `unzip`
(`UNZIP_BIN` override, otherwise on PATH), bounded to 16 entries and 80 MiB
per decoded member. Only the two exact evidence member names are read to
stdout; archive-controlled paths are never extracted. Downloads use at most
two concurrent requests, with 250 ms pacing before each GitHub request. The
normal daily collection target is at most about 700 GitHub calls; the hard cap is
800, counting every request attempt, including every retry. Transport failures
and HTTP 5xx responses receive backoff with at most three attempts total per
request, not three retries. Every attempt must satisfy the hard cap and the
remaining-budget floor of 200, reserving headroom for in-flight requests.
Reaching the API-call cap or remaining-budget floor emits an explicit repo-only
`buck2.cache.join.evidence_gaps` observation, preserves independent valid
observations already collected, and reports `budget_stopped` on stderr and
collection metadata in JSON output; it never presents a partial join as complete.
Artifact and byte safety caps fail rather than silently truncating. Temporary
evidence is removed on exit.

| Canonical OTel name                             | Prometheus translation                          | Point labels         |
| ----------------------------------------------- | ----------------------------------------------- | -------------------- |
| `buck2.cache.lane.eligible_actions`             | `buck2_cache_lane_eligible_actions`             | repo, lane, platform |
| `buck2.cache.lane.remote_hit_actions`           | `buck2_cache_lane_remote_hit_actions`           | repo, lane, platform |
| `buck2.cache.lane.avoidable_miss_actions`       | `buck2_cache_lane_avoidable_miss_actions`       | repo, lane, platform |
| `buck2.cache.lane.local_actions`                | `buck2_cache_lane_local_actions`                | repo, lane, platform |
| `buck2.cache.lane.cold_actions`                 | `buck2_cache_lane_cold_actions`                 | repo, lane, platform |
| `buck2.cache.lane.changed_actions`              | `buck2_cache_lane_changed_actions`              | repo, lane, platform |
| `buck2.cache.lane.noncacheable_actions`         | `buck2_cache_lane_noncacheable_actions`         | repo, lane, platform |
| `buck2.cache.lane.excluded_actions`             | `buck2_cache_lane_excluded_actions`             | repo, lane, platform |
| `buck2.cache.lane.upload_failure_actions`       | `buck2_cache_lane_upload_failure_actions`       | repo, lane, platform |
| `buck2.cache.lane.evidence_gaps`                | `buck2_cache_lane_evidence_gaps`                | repo, lane, platform |
| `buck2.cache.join.artifacts`                    | `buck2_cache_join_artifacts`                    | repo                 |
| `buck2.cache.join.runs`                         | `buck2_cache_join_runs`                         | repo                 |
| `buck2.cache.join.runs_seen`                    | `buck2_cache_join_runs_seen`                    | repo, lane           |
| `buck2.cache.join.runs_selected`                | `buck2_cache_join_runs_selected`                | repo, lane           |
| `buck2.cache.join.artifacts_selected`           | `buck2_cache_join_artifacts_selected`           | repo, lane           |
| `buck2.cache.join.window_end_timestamp_seconds` | `buck2_cache_join_window_end_timestamp_seconds` | repo                 |
| `buck2.cache.join.evidence_gaps`                | `buck2_cache_join_evidence_gaps`                | repo                 |

CE1 (REUSE-R08) is `avoidable_miss_actions / eligible_actions` per lane.
CE2 (REUSE-R09) is
`remote_hit_actions / eligible_actions` for `merge_group` and `pr`; CE3
(REUSE-R10) is the same ratio for `main-reader`. These are sampled ratios of
the summed selected action counts, not a mean of per-run percentages or an
extrapolation to unsampled runs. All main-writer runs and sampled merge-group
runs supply writer evidence; all sampled cohorts measure only their selected
runs. With merge-group writers sampled, CE1 avoidable-miss counts are a lower
bound: omitted writers can hide eligible misses. Eligibility and reported
ratios are computed against the selected writer cohort, not an inferred full
population. A zero eligible denominator means no measured rate, not a
zero-percent hit rate.
Preserve raw counts, selection coverage, and evidence gaps alongside ratios;
intentional sampling is not itself an evidence gap.

Action eligibility coverage is `eligible / (eligible + cold + changed)`,
distinct from the remote-hit ratio among eligible actions and from run-selection
coverage. For a selected daily window, compute it without a derived metric:

```promql
buck2_cache_lane_eligible_actions
/
(
  buck2_cache_lane_eligible_actions
  + buck2_cache_lane_cold_actions
  + buck2_cache_lane_changed_actions
)
```

The series match on `repo`, `lane`, and `platform`. A zero denominator means
no measured coverage, not zero coverage. These are window-total gauges; do not
apply `rate()` or `increase()`. Historical samples that predate
`changed_actions` do not support this split-cohort query.

- **CE1 Eligibility and counts:** The production warm99 join supplies exact
  identity eligibility: a successful upload by a writer-posture `main-writer`
  or `merge_group` artifact must finish strictly before the fresh reader
  invocation starts. Identity includes category, target, configuration and
  digest; another digest is `changed`, not an avoidable miss. `cold` counts
  identities without an earlier exact or base-identity upload; it does not
  include `changed`. Eligible remote hits
  use the native remote-hit execution kind; avoidable misses are eligible
  minus hits. Local actions count local command execution kinds, including
  successful uploads. Counts deduplicate identities within a reader artifact,
  then sum independent fresh reader artifacts. Replayed invocation evidence
  contributes a gap, not another observation.
  Noncacheable counts noncommand rows plus deduplicated noncacheable command
  identities under the warm99 classification. Excluded counts policy-excluded
  and nonfresh rows. Upload failures count failed-upload rows from the writer
  and reader evidence evaluated for each reader artifact, so shared writer
  failures can appear in multiple reader observations. These diagnostic counts
  and local actions are not extra terms in the coverage denominator.
- **CE2 Bounded dimensions and incomplete evidence:** `lane` is one of
  `main-reader`, `merge_group`, `pr`, `main-writer`; `platform` is `linux`,
  `darwin`, or `unknown`. An explicit producer-job map assigns platform;
  unrecognized jobs remain `unknown` rather than guessing from substrings.
  `repo` is the selected public owner/name. No target, digest, run ID, job
  name, trace ID, or host appears as a point label. Missing or invalid evidence
  contributes gaps without invalidating independent valid observations.
  Deliberately unassigned metadata lanes are ignored. Unassignable gaps appear
  in the repo-only join gap gauge; assignable gaps appear in lane/platform
  gauges. `join.runs` counts selected runs; `join.artifacts` counts all
  evidence-prefix artifacts discovered in those runs before expired/disabled
  filtering, including evidence that could not be decoded. Per-lane selection
  gauges use the discovered run cohort, not the decoded evidence lane, with
  `repo,lane` labels only: `runs_seen` counts runs before sampling,
  `runs_selected` counts retained runs, and `artifacts_selected` counts
  downloadable selected artifacts. Action gauges remain attributed by the
  strictly decoded lane and platform.
- **CE3 Day and delivery semantics:** Counts, including the per-lane
  `buck2.cache.join` selection metrics, are UTC-day window-total gauges, not
  monotonic counters. Previous-day mode selects the previous complete UTC
  day `[00:00Z, 24:00Z)`, not a rolling 24-hour window. Every OTLP
  point uses that selected window's exclusive end as `timeUnixNano`, never the
  execution time. Re-exporting a day therefore addresses the same sample
  timestamp rather than adding another day's count. These window-total gauges
  must not be queried with `rate()` or `increase()`. Prometheus text samples
  carry the same window-end timestamp in milliseconds; HELP and TYPE metadata
  carry no timestamp. OTLP resources identify
  `service.name=effect-utils-buck2` and `service.namespace=infra`; the CLI writes
  the existing pending metric spool format rather than introducing transport.
  The backend must accept samples at least 27 h old; the reference deployment
  allows 48 h. Its Mimir `out_of_order_time_window=48h` covers both the
  scheduled 03:17 UTC export (about 3.3 h after the sample timestamp) and
  manual previous-day exports (at most 24 h after it); the old-sample rejection
  limit is higher.

## Conformance

- Determinism: same local log and sidecar context → byte-identical views.
- Cap behavior: a 12,622-span command yields exactly ≤ 1,200 spans with the
  mandatory structure intact (121 mandatory spans; escalation documented via
  the effective threshold attribute).
- Summaries exact against the full model at every cap.
- An unseeded Buck command exports two independent, distinct, nonzero
  deterministic trace IDs without a fabricated task span or caller link;
  a seeded command puts only its critical view in the job trace.
- Evidence: [span-shaping and metrics](.experiments/2026-09-25-span-shaping-and-metrics.md),
  [span-cap benchmark](.experiments/2026-09-25-span-cap-benchmark.md),
  decisions [0001](.decisions/0001-trace-view-family.md),
  [0002](.decisions/0002-both-views-always-ingested.md).
