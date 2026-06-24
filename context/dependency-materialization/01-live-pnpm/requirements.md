# Live pnpm Requirements

## Context

Live pnpm materialization is the mutable worktree realization of the
[dependency materialization contract](../requirements.md). It covers local
development, devenv tasks, and CI jobs that run against a checked-out
workspace.

The live model is the authority for workspace topology, install ownership, and
runtime dependency identity. Nix prepared dependency artifacts, Buck2 evidence,
and observability derive from this model instead of inventing a parallel
dependency graph.

## Assumptions

- **A01 DMP base:** This subsystem refines DMP-R01 through DMP-R19.
- **A02 Canonical topology:** A managed install receives one selected workspace
  topology and one install owner before pnpm is invoked.
- **A03 Mutable realization:** Live `node_modules`, pnpm metadata, GVS links,
  and package projections are mutable profile state, not immutable dependency
  artifacts.

## Acceptable Tradeoffs

- **T01 Explicit roots:** Workspaces may require explicit root/task selection
  rather than accepting arbitrary package-directory installs.
- **T02 Job-local CI:** CI may give up host-wide mutable-state reuse to keep
  concurrent jobs isolated.
- **T03 Shared content with local metadata:** Local development may share
  package content across profiles only when metadata, projection, repair, and
  GC authority remain explicit.

## Requirements

### Must preserve topology authority

- **DMP.LIVE-R01 Install owner:** Every live install must name its owner root
  and topology. Package-local or sibling-root installs must not become
  authoritative implicitly.
- **DMP.LIVE-R02 Standalone validity:** A repo must remain installable through
  its own canonical workspace topology even when it is also consumed from a
  composed workspace.
- **DMP.LIVE-R03 Composed validity:** A composed workspace must use its own
  generated or declared aggregate topology and must not mutate nested repo
  lockfiles as a side effect.
- **DMP.LIVE-R04 Nested roots:** Nested authoritative install roots must be
  modeled as explicit managed install roots with separate profile state.

### Must preserve dependency identity

- **DMP.LIVE-R05 Single graph identity:** Equivalent dependency graphs for the
  same physical source tree should converge on one runtime dependency instance
  within one composed runtime graph.
- **DMP.LIVE-R06 Local source linkage:** Workspace and cross-repo local
  dependencies must resolve to live source when that is the selected topology.
- **DMP.LIVE-R07 Dependency truthfulness:** The linker/projection model must not
  silently make undeclared dependencies valid.

### Must remain pure and repairable

- **DMP.LIVE-R08 Script policy:** Live installs must obey the root strict pnpm
  lifecycle policy and reject re-enabling dependency scripts.
- **DMP.LIVE-R09 Projection validation:** A skipped or cached install is valid
  only when dependency data and projection state are healthy for the selected
  topology.
- **DMP.LIVE-R10 Safe concurrency:** CI and disposable task roots must keep
  writable pnpm state job-local unless a stronger shared-state proof exists.
- **DMP.LIVE-R11 Observable reuse:** Install reuse, invalidation, repair, and
  projection decisions must emit machine-readable evidence.
