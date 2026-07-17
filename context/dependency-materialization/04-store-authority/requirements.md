# Store Authority Requirements

## Context

Store authority defines when dependency content may be shared and who may
repair, prune, or garbage-collect it. It refines DMP-R12 through DMP-R15.

## Assumptions

- **A01 pnpm mutable state:** pnpm metadata, virtual topology, side-effects
  cache, and projection files are root-local mutable state unless a Nix artifact
  proves otherwise.
- **A02 Sharing is valuable:** Host-wide package-content sharing is a desired
  optimization when correctness and repair semantics are explicit.

## Acceptable Tradeoffs

- **T01 Refuse unsafe shared-pool mutation:** Commands may fail closed when they
  cannot prove authority over every active root before sweeping a Shared Content
  Pool.
- **T02 Scope-specific placement:** Local development, CI, and Nix may place
  immutable content differently while preserving the same ownership rules.

## Requirements

### Must declare authority

- **DMP.STORE-R01 Independent storage facts:** Evidence and configuration must
  state writable-state scope, content-pool scope, and system applicability as
  independent facts rather than one preset name.
  Refines: DMP-R12.
- **DMP.STORE-R02 Mutable owner:** Writable package-manager metadata and
  Dependency Graph state and Projection State must be owned by exactly one
  Materialization Root. A Shared Content Pool must not contain writable graph
  topology.
  Refines: DMP-R12.
- **DMP.STORE-R03 Shared pool GC authority:** effect-utils must not expose or
  invoke managed Shared Content Pool GC unless an authority can enumerate every
  active Materialization Root that references the pool.
  Refines: DMP-R13.
- **DMP.STORE-R04 Managed prune refusal:** An effect-utils-managed operation
  scoped to one Materialization Root must refuse to prune a Shared Content Pool
  without the authority required by DMP.STORE-R03.
  Refines: DMP-R14.

### Must be repairable

- **DMP.STORE-R05 Explicit offline readiness:** Materialization Root health must
  not imply Shared Content Pool completeness. Any offline-readiness claim must
  name its declared inputs and carry separate no-network evidence.
  Refines: DMP-R13, DMP-R19.
- **DMP.STORE-R06 Deterministic repair:** Repair must rebuild from declared
  inputs and must not rewrite lockfiles.
  Refines: DMP-R15.
- **DMP.STORE-R07 Low-disk safety:** Low-disk refusal and recovery must be
  explicit rather than leaving a Materialization Root apparently healthy but
  unusable.
  Refines: DMP-R15.

### Must be measured

- **DMP.STORE-R08 Benchmark evidence:** Changes to storage placement or sharing
  must report the comparison evidence defined by the verification subsystem.
  Refines: DMP-R16.
- **DMP.STORE-R09 Default gate:** A sharing strategy may become default only
  after proving correctness and material cache-efficiency gains on real
  workspaces.
  Refines: DMP-R16.
