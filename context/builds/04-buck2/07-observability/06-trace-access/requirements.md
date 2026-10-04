# Trace Access Requirements

This subsystem owns the PR job report and deterministic Grafana links. The report reads CI job timings from the provider's Jobs API; for consumer profiles selecting this link-format adapter, Grafana reads exported traces from the configured Tempo datasource. Collector deployment, export admission and retention remain consumer-owned. It refines BUILD.BUCK.OBS-R03, BUILD.BUCK.OBS-R04, and BUILD.BUCK.OBS-R08 of the [observability requirements](../requirements.md).

## Assumptions

- **BUILD.BUCK.OBS.ACCESS-A01 Deterministic identity:** [01](../01-run-identity/spec.md) derives the job trace ID from pipeline run identity and matrix-qualified job key before export. A PR comment does not need Tempo access to construct that link.
- **BUILD.BUCK.OBS.ACCESS-A02 CI-owned comment:** The existing GitHub workflow-report sticky comment has GitHub write authority. The consumer backend has none; its trace API is not a CI read source.

## Acceptable Tradeoffs

- **BUILD.BUCK.OBS.ACCESS-T01 Job-level report:** The current PR comment shows job status, wall time, baseline delta, and a job gantt. Task-level durations, critical chains and task baselines require a separately authorized backend-read design and are not inferred from GitHub job timings.
- **BUILD.BUCK.OBS.ACCESS-T02 Direct link readiness:** A deterministic Grafana link can precede backend visibility or outlive consumer-selected trace retention; it is a locator, not a completeness or access guarantee.

## Requirements

### Must report observable job outcomes

- **BUILD.BUCK.OBS.ACCESS-R01 PR job source (refines BUILD.BUCK.OBS-R03):** The PR
  comment's job table and gantt take timings and conclusions only from the
  GitHub Actions Jobs API for the current run/attempt. They report each
  matrix-qualified job's status, wall time where both timestamps exist,
  and missing, skipped, cancelled, or unfinished timings explicitly.
  A close/finalizer job is not treated as a build job.
- **BUILD.BUCK.OBS.ACCESS-R02 CI-owned publication:** The existing workflow-report sticky PR comment is updated by CI at attempt close after dependent build jobs settle. No fleet-host GitHub write credential, run-record service, artifact aggregation, or Tempo read is required; ordinary fork jobs retain the workflow's no-write guard.

### Must compare completed jobs fairly

- **BUILD.BUCK.OBS.ACCESS-R03 Job baseline:** Enumerate successful completed
  main-branch runs of the same repository and workflow via the GitHub Actions
  workflow-runs API. For each PR job key, compare its wall duration to p50
  of that job among the latest seven eligible successful main runs using
  Jobs API timings. Report signed absolute and percentage deltas and sample
  count; no matching successful job samples means `baseline unavailable`.
  A PR job without both timestamps has no delta even when a baseline exists.
  Never count cancelled, skipped, failed, or incomplete main jobs as
  successful duration samples.
- **BUILD.BUCK.OBS.ACCESS-R04 Job gantt:** Show each executed job's started/completed window on one attempt-level time axis, marking unfinished/missing timings and final conclusions separately. The chart must not turn a missing or cancelled job into zero-duration success.

### Must link traces without a read proxy

- **BUILD.BUCK.OBS.ACCESS-R05 Deterministic Grafana links (refines BUILD.BUCK.OBS-R04):** Construct each eligible job's Grafana Explore by-ID URL from 01's deterministic trace ID and the configured Grafana base URL/Tempo datasource; no Tempo search, resolver, index, or CI read permission to the consumer backend is required. A link is not a claim that delivery succeeded.
- **BUILD.BUCK.OBS.ACCESS-R06 Scoped API usage (refines BUILD.BUCK.OBS-R08):** The GitHub-specific Jobs API and comment write remain in the GitHub workflow adapter; telemetry capture, OTLP transport, and identity stay provider-neutral. Another provider supplies equivalent job facts to the report model rather than changing the exporter.
- **BUILD.BUCK.OBS.ACCESS-R07 Least-privilege display:** The report escapes externally supplied job names and URLs for Markdown; CI does not receive unrestricted Tempo read access, arbitrary TraceQL permission, or a backend-wide trace token. Reviewers follow Grafana links under their own consumer-selected backend access.

## Requirement Trace

| Requirements                 | Refinement        |
| ---------------------------- | ----------------- |
| BUILD.BUCK.OBS.ACCESS-R01–R04, R06 | BUILD.BUCK.OBS-R03, R08 |
| BUILD.BUCK.OBS.ACCESS-R05, R07     | BUILD.BUCK.OBS-R04, R08 |
