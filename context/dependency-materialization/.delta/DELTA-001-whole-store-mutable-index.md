# DELTA-001: Whole Store Cache shares mutable pnpm indexes

Status: open

## Divergence

The current live-development realization shares one complete pnpm Store Cache,
including pnpm-mutated derived indexes, across Materialization Roots. This gives
measured second-root acceleration but does not satisfy the normative pure
cross-root reusable-state boundary.

## VRS

- [DMP-R21 and DMP-R24](../requirements.md) admit only declared-input-derived,
  immutable state and hermetic topology work to cross-root reuse.
- [Decision 0006](../.decisions/0006-pure-reuse-with-root-local-graph-authority.md)
  selects a Hermetic Dependency Artifact as the architectural target.
- [Store authority](../04-store-authority/requirements.md) keeps mutable
  package-manager indexes outside the claimed reusable layer.

## Implementation

`nix/devenv-modules/tasks/shared/pnpm.nix` supplies one host Store Cache to
managed local installs. pnpm mutates its derived indexes under cache admission
and maintenance coordination. The committed storage evidence demonstrates that
this whole-store realization avoids second-root downloads. The focused
[split-files prune experiment](../04-store-authority/.experiments/2026-06-22-split-files-pool-prune.md)
proves that mutually invisible indexes over one files pool cannot independently
own destructive prune authority.

## Resolution Approach

Replace cross-root mutable index sharing with either:

1. immutable/integrity-addressed package data plus independently recoverable
   writable metadata; or
2. a Hermetic Dependency Artifact that captures reusable graph/topology work by
   complete declared-input identity and is consumed read-only.

A read-only seed with root-local writable overlays is admissible if it preserves
the same purity, atomic publication, independent repair, and maximal-data-reuse
properties. Do not regress to mutually invisible indexes over a destructively
pruned shared files pool.

## Direction

update implementation

## Resolution Signal

- Cross-root state is immutable after atomic publication and keyed by complete
  declared or content identity.
- Each mutable package-manager index can be discarded or repaired without
  coordinating an independent Materialization Root.
- Same-workload second-root online/offline, concurrent-root, physical-byte,
  inode/file-count, and repair benchmarks meet the DMP.VER-R12 gates.
- The whole-store compatibility path and this delta are removed.
