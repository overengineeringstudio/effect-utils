# Trace Access Requirements

This subsystem owns human and agent discovery of the trace views produced by
[04-trace-views](../04-trace-views/spec.md) and indexed by
[05-ingest-and-archive](../05-ingest-and-archive/spec.md). It refines
BUCK.OBS-R03, BUCK.OBS-R04, BUCK.OBS-R08, and BUCK.OBS-R01 of the
[observability requirements](../requirements.md).

## Assumptions

- **BUCK.OBS.ACCESS-A01 Indexed identity:** Sealed records and the ingest index
  carry PR and revision identity and deterministic trace IDs as specified by
  [02](../02-run-record/spec.md) and [05](../05-ingest-and-archive/spec.md).
- **BUCK.OBS.ACCESS-A02 Fleet admission:** The resolver is accessible only on
  the tailnet; fleet deployment and its read-only service boundary are owned
  by dotfiles.

## Acceptable Tradeoffs

- **BUCK.OBS.ACCESS-T01 Tailnet access:** A reviewer must join the tailnet to
  open the resolver or its trace viewers; V1 does not expose traces publicly.
- **BUCK.OBS.ACCESS-T02 Snapshot cost:** Freezing a review snapshot is an
  explicit on-demand action, not work on every PR page request.

## Requirements

### Must make traces discoverable without backend search

- **BUCK.OBS.ACCESS-R01 Stable PR entry (refines BUCK.OBS-R04):** A PR-scoped
  resolver URL must identify its runs, jobs, and trace links from the ingest
  index without Tempo attribute search; links resolve to a pending state
  before ingestion and to the trace after complete readback.
- **BUCK.OBS.ACCESS-R02 CI-owned links (refines BUCK.OBS-R03):** Seal-time
  trace links and a PR-scoped resolver link must be available in a
  provider-neutral summary sink. The GitHub CI adapter adds the PR link to
  the existing sticky comment and copies the summary links into its step
  summary. The fleet host holds no GitHub write credential.

### Must make a noisy comparison interpretable

- **BUCK.OBS.ACCESS-R03 Review overview:** The PR page must show a verdict,
  the slowest job's critical chain, runs then jobs then top tasks, and links
  to Grafana and Perfetto for the corresponding traces. When a Buck action
  critical path exists, it replaces the task-span chain.
- **BUCK.OBS.ACCESS-R04 Main-run baseline:** The A/B view must compare each
  PR task duration with the median of up to seven main runs at or before the
  merge base, displaying the main-run spread as a noise band and distinguishing
  deltas inside it from those outside it. It must disclose a missing or
  incomplete baseline rather than present a single run as a stable median.
- **BUCK.OBS.ACCESS-R05 Frozen review:** The read-only resolver page makes a
  copyable `gh-ci-utils traces <pr> --freeze` command available. An agent or
  operator runs it in their own Vista context to publish a frozen snapshot
  from resolver JSON when a review artifact must outlive Tempo's 30-day
  window. Resolver page loads and reads do not publish snapshots.

### Must give agents a stable contract

- **BUCK.OBS.ACCESS-R06 Versioned JSON (refines BUCK.OBS-R08):** The resolver
  exposes versioned JSON for the same PR/run/job/trace identities and verdict
  shown in HTML. `gh-ci-utils traces <pr>` consumes it and reports trace IDs,
  relevant deltas, and next actions; `--freeze` consumes the same JSON and
  publishes through the caller's Vista context. An off-tailnet request fails
  with an explicit access message, not an empty PR result.
- **BUCK.OBS.ACCESS-R07 Read-only and safe display (refines BUCK.OBS-R01):**
  Resolver reads cannot mutate ingestion state; untrusted evidence fields
  render as escaped text, not executable HTML. Trace IDs are locators, not
  bearer capabilities; access is still governed by the tailnet boundary.

## Requirement Trace

| Requirements | Refinement |
| --- | --- |
| BUCK.OBS.ACCESS-R01, R02 | BUCK.OBS-R04, R03 |
| BUCK.OBS.ACCESS-R03–R05 | BUCK.OBS-R01 |
| BUCK.OBS.ACCESS-R06, R07 | BUCK.OBS-R08, R01 |
