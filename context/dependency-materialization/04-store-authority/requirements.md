# Store Authority Requirements

## Context

Store authority defines when dependency content may be shared and who may
repair, prune, or garbage-collect it. It refines DMP-R12 through DMP-R15.

## Assumptions

- **A01 pnpm mutable state:** pnpm metadata, links, side-effects cache, and
  projection files are mutable local state unless a Nix artifact proves
  otherwise.
- **A02 Sharing is valuable:** Host-wide package-content sharing is a desired
  optimization when correctness and repair semantics are explicit.

## Acceptable Tradeoffs

- **T01 Refuse unsafe repair:** Commands may fail closed when they cannot prove
  authority over every active root.
- **T02 Trait-specific defaults:** Darwin, Linux, CI, and Nix may use different
  store traits under one profile vocabulary.

## Requirements

### Must declare authority

- **DMP.STORE-R01 One trait:** Every profile must declare exactly one store
  trait.
- **DMP.STORE-R02 Mutable owner:** Writable package-manager metadata and
  projection state must have one owner.
- **DMP.STORE-R03 Shared pool root set:** A shared content pool may be swept
  only by an authority that can enumerate every active root.
- **DMP.STORE-R04 Raw prune refusal:** Profile-local prune must refuse when it
  would sweep a shared content pool without root-set authority.

### Must be repairable

- **DMP.STORE-R05 Missing content detection:** Health checks must detect
  missing shared content needed for offline reuse or projection.
- **DMP.STORE-R06 Deterministic repair:** Repair must rebuild from declared
  inputs and must not rewrite lockfiles.
- **DMP.STORE-R07 Low-disk safety:** Low-disk refusal and recovery must be
  explicit rather than leaving a profile apparently healthy but unusable.

### Must be measured

- **DMP.STORE-R08 Benchmark matrix:** Candidate traits must report cold, warm,
  offline, concurrent, byte, and file-count metrics.
- **DMP.STORE-R09 Default gate:** A trait may become default only after proving
  correctness and material cache-efficiency gains on real workspaces.
