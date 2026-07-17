# Live pnpm Requirements

## Context

Live pnpm materialization is the mutable worktree realization of the
[dependency materialization contract](../requirements.md). It covers local
development, devenv tasks, and CI jobs that run against a checked-out
workspace.

The live model names the authoritative workspace topology, Materialization
Root, and Authoritative Materializer. Nix prepared dependency artifacts, Buck2
evidence, and observability derive from this model instead of inventing a
parallel Dependency Graph.

## Assumptions

- **A01 DMP base:** This subsystem refines DMP-R01 through DMP-R19.
- **A02 Canonical topology:** A managed install receives one selected workspace
  topology and one Materialization Root before pnpm is invoked as its
  Authoritative Materializer.
- **A03 Mutable realization:** Live `node_modules`, its root-local virtual
  store, pnpm metadata, and package projections are mutable Materialization
  Root state, not immutable dependency artifacts or state owned by a
  Materialization Profile.

## Acceptable Tradeoffs

- **T01 Explicit roots:** Workspaces may require explicit root/task selection
  rather than accepting arbitrary package-directory installs.
- **T02 Job-local CI:** CI may give up host-wide mutable-state reuse to keep
  concurrent jobs isolated.
- **T03 Shared content with local metadata:** Local development may share
  package content across Materialization Roots only when metadata, projection,
  repair, and GC authority remain explicit.

## Requirements

### Must preserve topology authority

- **DMP.LIVE-R01 Materialization Root:** Every live install must name its
  Materialization Root, Authoritative Materializer, and topology. Package-local
  or sibling-root installs must not become authoritative implicitly.
  Refines: DMP-R11.
- **DMP.LIVE-R02 Standalone validity:** A repo must remain installable through
  its own canonical workspace topology even when it is also consumed from a
  composed workspace.
  Refines: DMP-R11, DMP-R16.
- **DMP.LIVE-R03 Composed validity:** A composed workspace must use its own
  generated or declared aggregate topology and must not mutate nested repo
  lockfiles as a side effect.
  Refines: DMP-R11.
- **DMP.LIVE-R04 Nested roots:** Nested authoritative install roots must be
  modeled as explicit Materialization Roots with separate mutable realization
  state and root-local virtual topology. Equivalent roots may share immutable
  content bytes, but not writable dependency graph state.
  Refines: DMP-R11, DMP-R12.

### Must preserve dependency identity

- **DMP.LIVE-R05 Single graph identity:** Within one composed runtime graph,
  equivalent Dependency Edges for the same physical source must target one
  Package Instance.
  Refines: DMP-R11.
- **DMP.LIVE-R06 Local source linkage:** Workspace and cross-repo local
  dependencies must resolve to live source when that is the selected topology.
  Refines: DMP-R11.
- **DMP.LIVE-R07 Dependency truthfulness:** Every realized Dependency Edge must
  target the Package Instance selected by pnpm, including its resolved version
  and peer context. Projection must not add, remove, or retarget those edges.
  Repair must discard the Materialization Root's derived dependency state and
  reinvoke pnpm rather than link a replacement.
  Refines: DMP-R11, DMP-R15.

### Must remain pure and repairable

- **DMP.LIVE-R08 Script policy:** Live installs must obey the root strict pnpm
  lifecycle policy and reject re-enabling dependency scripts.
  Refines: DMP-R01, DMP-R02, DMP-R03.
- **DMP.LIVE-R09 Projection validation:** A skipped or cached install is valid
  only when Dependency Data and Projection State are healthy for the selected
  topology, generated install contract, and declared inputs. A topology-
  containment oracle must reject a pnpm Package Instance dependency edge that
  escapes its Materialization Root. Exact edge identity remains pnpm's
  responsibility under DMP.LIVE-R07; no secondary writer may retarget it.
  Refines: DMP-R06, DMP-R15.
- **DMP.LIVE-R10 Safe concurrency:** CI and disposable task roots must keep
  writable pnpm state job-local. Local development roots may share only an
  immutable content-addressed pool; virtual topology remains root-local.
  Refines: DMP-R12, DMP-R13, DMP-R14.
- **DMP.LIVE-R11 Observable reuse:** Install reuse, invalidation, repair, and
  projection decisions must emit machine-readable evidence.
  Refines: DMP-R19.
