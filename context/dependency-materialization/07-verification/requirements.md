# Dependency Materialization Verification Requirements

## Context

Verification defines the proof, benchmark, and regression architecture for
dependency materialization. It refines DMP-R11 and DMP-R16 through DMP-R20 and
composes the live pnpm, projection, Nix prepared-deps, store-authority, Buck2
evidence, and observability subsystems.

## Assumptions

- **A01 Layered evidence:** Cheap fixtures catch contract regressions, while
  real-workload benchmarks gate defaults and cache-efficiency claims.
- **A02 External evidence:** Prototype branches, downstream experiments,
  historical change records, CI artifacts, and local measurements are evidence
  inputs, not the owning VRS surface. effect-utils owns the reusable
  verification contract.

## Acceptable Tradeoffs

- **T01 Tiered runtime:** Not every proof runs on every commit; expensive,
  host-sensitive, or cross-system benchmarks may run on demand or before a
  default changes.
- **T02 Skippable environment gates:** Benchmarks may emit machine-readable
  skip records for missing platform, low disk, or unavailable remote hosts.

## Requirements

### Must cover correctness

- **DMP.VER-R01 Fixture regressions:** Unit and smoke fixtures must cover
  profile identity, strict install rejection, projection health, native package
  classification, and doctor/repair decisions.
  Refines: DMP-R16, DMP-R17, DMP-R20.
- **DMP.VER-R02 Negative lifecycle proof:** At least one fixture must prove
  that managed materialization does not run dependency lifecycle scripts,
  rebuilds, or approval flows.
  Refines: DMP-R17.
- **DMP.VER-R03 Prepared artifact scan proof:** Prepared dependency validation
  must have fixtures that reject `.bin`, unexpected native output, known
  platform package directories, and leaked package-manager state.
  Refines: DMP-R05, DMP-R08, DMP-R18.
- **DMP.VER-R04 Shared-store failure proof:** Store-authority changes must
  preserve a proof that raw profile-local prune can break sibling offline
  reinstall for shared pools and that coordinated repair targets every root.
  Refines: DMP-R13, DMP-R14, DMP-R15.

### Must cover performance and sharing

- **DMP.VER-R05 Benchmark matrix:** Store-trait changes must record cold,
  warm, offline, concurrent, byte, file-count, and repair metrics.
  Refines: DMP-R16, DMP-R19, DMP.STORE-R08.
- **DMP.VER-R06 Real-workload gate:** Default changes require at least one
  downstream real graph for each affected platform class, or an explicit
  pending-system marker that prevents overgeneralized conclusions.
  Refines: DMP-R16, DMP-R18.
- **DMP.VER-R07 Cache-efficiency comparison:** Claims about host-wide sharing
  must compare against an isolated baseline on the same graph and machine
  class.
  Refines: DMP-R16, DMP.STORE-R09.

### Must be auditable

- **DMP.VER-R08 Machine-readable evidence:** Proofs and benchmarks must emit
  stable records for status, inputs, platform, store trait, timings, sizes, and
  skip reasons.
  Refines: DMP-R19, DMP.OBS-R01, DMP.OBS-R02.
- **DMP.VER-R09 Decision linkage:** Consequential DMP decisions must name the
  evidence category that justifies them and any evidence still pending.
  Refines: DMP-R20.
- **DMP.VER-R10 Research graduation:** Prototype or downstream research may be
  retired only after each durable finding is represented by a verification
  requirement, implemented as a reusable proof or benchmark, recorded as
  pending evidence, or explicitly rejected with rationale.
  Refines: DMP-R20.

### Must prove dependency identity

- **DMP.VER-R11 Dependency-identity proof:** Changes to materialization,
  projection, or repair behavior must prove that same-name multi-version and
  distinct peer-context package instances preserve their materializer-selected
  identities across install order. The proof must include a negative
  out-of-band edge override that the identity oracle detects.
  Refines: DMP-R11, DMP.LIVE-R07, DMP.PROJ-R09, DMP-R20.
