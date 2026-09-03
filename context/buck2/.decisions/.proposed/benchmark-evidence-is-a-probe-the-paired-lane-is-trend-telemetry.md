# Benchmark evidence per admission is a targeted probe; the paired lane is trend telemetry

## Status

proposed

## Context

BUCK-R16 requires that each admission record warm no-op time, fresh-context
time with a warm shared cache, cache-hit rate for unchanged targets, and the CI
wall-clock delta against the pre-admission baseline. BUCK-R15 requires a net
complexity ledger per phase. Both were ratified on 2026-08-29 as requirement
text (commit `5dd8c4f4b`, "docs(buck2): ratify measurable complexity and
benchmark requirements") without a decision record, so nothing recorded _where_
that evidence is produced.

In practice it was produced nowhere in particular, and a lane was paying for it
anyway. `devenv-perf` — the paired wall-clock lane — ran on every pull request
with a 90-minute timeout on a 16-vCPU paired Namespace worker, `regressionMode:
'warn'`, `compare: false`, and `prComment.enabled: false`. It was also a
required status check. Measured on three consecutive `ci.yml` runs it took
**35.0 / 35.7 / 35.0 minutes** against a **37.4-minute whole-run wall clock**:
the lane was the critical path for the entire workflow, and it neither blocked
on a regression nor said anything on the pull request. Its ~29 probe executions
measure the whole devenv surface — `pnpm:install`, `genie:run`, `genie:check`,
warm and forced `check:quick`, shell eval — on every change, including changes
that touch none of it.

The upcoming Buck2 foundation work makes this concrete rather than theoretical.
The foundation admissions are a sequence of pull requests whose _own_ cost is
about 2 minutes of `buck2 check` plus ~17 minutes of macOS validation. Paying 35
advisory minutes per admission for numbers that nobody reads, and that no
requirement asks to be collected per pull request, would have dominated the
schedule of the very work whose efficiency BUCK-R16 exists to measure.

Options considered:

- **Option 0 — leave it required per pull request and make it useful** (enable
  `prComment`, set `regressionMode: 'block'`). Rejected: this is the more
  expensive direction, and the lane's own gate policies say wall-clock rows need
  paired same-run base/head evidence before they can block. `compare: false`
  means the lane does not even produce that evidence today; making it blocking
  first would gate merges on historical bands the measurement spec explicitly
  forbids as a merge gate.
- **Option 1 (chosen) — split the two jobs the lane was conflating.** A cadence
  lane for the trend series, a targeted probe for per-admission evidence.
- **Option 2 — delete the lane and rely on ad-hoc probes.** Rejected: the trend
  series is the only thing that detects slow drift nobody's individual change is
  responsible for, and it is exactly what a cadence is good at. Deleting it also
  throws away the measurement engine, its baseline provenance, and its seeded
  history.

## Decision

1. **Per-admission BUCK-R16 evidence is a targeted probe recorded with the
   admission**, in the admission's `.experiments/` record: warm no-op,
   fresh-context with a warm shared cache, cache-hit rate for unchanged targets,
   and the CI wall-clock delta. The probe is scoped to the surface the admission
   touches. BUCK-R16's content is unchanged; only its production site is now
   stated.

2. **The paired `devenv-perf` lane is trend telemetry on a cadence, not a
   per-change gate.** It runs on a nightly `schedule` against `main`, on
   operator `workflow_dispatch` (including measurement baseline backfill), and
   on a pull request carrying the `ci:perf` label when one genuinely needs the
   numbers before merge. It is not removed, not narrowed, and its probe set is
   unchanged — every observation id stays stable, so the series is continuous
   across the cadence change.

3. **The lane is no longer a required status check**, because a lane that does
   not run on every pull request cannot be one: a skipped job reports no check
   run, so branch protection would wait forever. This is a consequence of (2),
   not an independent loosening — the lane never blocked on a measurement
   verdict, so nothing that used to fail a merge stops doing so.

4. **The trend series moves with the producer.** The report's baseline candidate
   scan for the perf family reads `schedule` runs instead of `push` runs. Until
   nightly runs accumulate, the perf family in `ci/measurements-report` renders
   current-only, which is the same graceful path the engine already takes for a
   newly introduced metric.

## Consequences

- A Buck2 foundation admission costs ~2 min `buck2 check` + ~17 min macOS
  instead of ~37 min, because the 35-minute lane is off the critical path.
- Wall-clock regression attribution gets coarser: a nightly series localizes a
  regression to a day of merges rather than to a commit. Accepted — the lane
  produced no attribution at all while `compare: false` and `prComment` were
  off, and `ci:perf` recovers per-pull-request numbers on demand for a change
  that plausibly moves them.
- The `ci:perf` grant is maintainer-managed and revocable, consistent with the
  other `ci:*` capability labels.
- BUCK-R15's ledger is unaffected: this deletes no machinery and adds a trigger
  predicate plus one label.

## Open

Whether the nightly lane should turn `compare: true` with `regressionMode:
'warn'` and publish a daily summary now that it has a stable cadence to compare
against. Deferred: it needs a noise profile from the nightly series first, which
does not exist yet.
