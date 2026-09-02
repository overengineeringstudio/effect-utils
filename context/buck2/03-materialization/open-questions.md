# Materialization Open Questions

## DQ1: How should CI obtain fetch artifacts without a warm buck-out?

- Blocks: CI wall-clock and registry dependence once the declared closure
  lands (decision 0022).
- Resolution signal: measured restore time of a cached fetch/extract subtree
  versus registry download. Scale note (2026-09-01): the ~600 MB estimate
  anticipates the Phase-4 whole-workspace closure; the admitted two-package
  surface measured only 71 MiB per run (CI run #5142), so refinement is
  correctly deferred until Phase 4 makes the cost real.
- Blocker: deliberately deferred — start with registry downloads per run and
  refine later (q4, 2026-08-30).
- Lane (ratified 2026-09-01): a tailnet read-only cache lane — bazel-remote
  alerting first, then an ephemeral-tailscale spike on a CI runner, then the
  lane with fail-open fallback. The GH-artifact fetch/extract-subtree cache
  keyed on the sidecar digest with a single fail-closed publisher is the
  fallback if the runner spike fails.

## DQ2: Can hardlink aliasing inside `buck-out` be made safe?

RESOLVED by [decision 0025](../.decisions/0025-cow-reflink-local-disk-economics.md)
(2026-09-01): assembly becomes reflink-first — copy-on-write clones carry
independent inodes with shared blocks, eliminating the write-through
corruption hazard instead of documenting it. Hardlink sharing into assembled
trees is rejected (rewritten DEPS-R04). Until the assembler change lands the
divergence is tracked as
[DELTA-001](./.delta/DELTA-001-assembler-hardlinks-pending-0025.md); on
filesystems without reflink support the fallback is a plain copy, and the
original hazard cannot recur because links are no longer produced.
