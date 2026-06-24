# FOD Hash Evidence Requirements

## Context

FOD hash evidence is the producer-side contract that lets repair tooling and
reviewers distinguish validated shared hashes from stale, collapsed, or
under-measured hashes.

The committed source of truth remains the Nix hash field consumed by the
prepared dependency derivation. Evidence is generated from evaluation, builds,
CI, or hash repair runs; it is not a second per-target witness file checked
into package source.

## Assumptions

- **A01 Prepared-deps parent:** This subsystem refines
  DMP.NIX-R03, DMP.NIX-R08, and DMP.NIX-R09.
- **A02 External repair consumers:** External hash repair tools may consume
  this evidence, but effect-utils owns the producer schema for prepared
  artifacts.
- **A03 Repair authority:** Hash repair tooling owns measurement,
  reconciliation, and rich run evidence. The effect-utils source surface must
  make that tooling reliable without duplicating its state.

## Requirements

### Must prevent unsafe hash collapse

- **DMP.NIX.FOD-R01 Covered systems:** Hash evidence must list the systems a
  prepared artifact claims to cover.
  Refines: DMP.NIX-R08.
- **DMP.NIX.FOD-R02 Measurement state:** Each covered system must be marked
  `measured`, `pending`, or `not-applicable`.
  Refines: DMP.NIX-R08.
- **DMP.NIX.FOD-R03 Shared hash proof:** A shared hash may be selected only
  when every covered system is measured equal or explicitly pending in a way
  that prevents treating the hash as fully proven.
  Refines: DMP.NIX-R03, DMP.NIX-R08.
- **DMP.NIX.FOD-R04 Split hash proof:** Platform-specific hashes must record
  the measured output hash per system.
  Refines: DMP.NIX-R03, DMP.NIX-R08.

### Must support repair tooling

- **DMP.NIX.FOD-R05 Direct attr:** Evidence must name the direct prepared deps
  attr to rebuild.
  Refines: DMP.NIX-R09.
- **DMP.NIX.FOD-R06 Inputs digest:** Evidence must include the prepared profile
  id and policy/artifact version digests.
  Refines: DMP.NIX-R08.
- **DMP.NIX.FOD-R07 Diagnostic text:** Stale hash failures must point at the
  direct dependency artifact, not only the final package.
  Refines: DMP.NIX-R09.
- **DMP.NIX.FOD-R08 No parallel source authority:** The producer contract must
  be derived from evaluated package metadata and committed hash declarations,
  not from a separate checked-in witness file that can drift from the Nix
  derivation.
  Refines: DMP.NIX-R08, DMP.NIX-R09.
- **DMP.NIX.FOD-R09 No committed witness files:** Package source must not add
  per-target FOD witness files. If repair tooling needs more context, it should
  consume eval-time metadata derived from `mkPnpmCli` inputs and emit run
  evidence outside the source tree.
  Refines: DMP.NIX-R08, DMP.NIX-R09.
