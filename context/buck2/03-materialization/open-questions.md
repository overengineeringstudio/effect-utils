# Materialization Open Questions

## DQ1: How should CI obtain fetch artifacts without a warm buck-out?

- Blocks: CI wall-clock and registry dependence once the declared closure
  lands (decision 0022).
- Resolution signal: measured restore time of a cached fetch/extract subtree
  versus registry download of ~600 MB per job.
- Blocker: deliberately deferred — start with registry downloads per run and
  refine later (q4, 2026-08-30).
- Lean: cache the fetch/extract subtree keyed on the sidecar digest with a
  single fail-closed publisher; a tailnet cache lane only after bazel-remote
  alerting exists.

## DQ2: Can hardlink aliasing inside `buck-out` be made safe?

- Blocks: nothing today; a write through an assembled tree corrupts the shared
  artifact silently.
- Resolution signal: a Buck-side mechanism to keep extract outputs read-only
  after materialization, or reflink support on the host filesystem.
- Blocker: Buck resets output modes after actions; ext4 has no reflink.
- Lean: enforce read-only on published editor views (done) and document the
  hazard; revisit if a consumer is observed writing into `buck-out`.
