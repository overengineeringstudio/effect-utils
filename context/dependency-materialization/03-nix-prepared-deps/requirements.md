# Nix Prepared Dependencies Requirements

## Context

Nix prepared dependencies are immutable realizations of the dependency
materialization contract for Nix-built TypeScript CLIs and other Nix consumers.
They derive from the live topology contract in
[../01-live-pnpm/requirements.md](../01-live-pnpm/requirements.md) and use
projection semantics from
[../02-projections/requirements.md](../02-projections/requirements.md).

## Assumptions

- **A01 Canonical inputs:** The authoritative lockfile, manifests, workspace
  membership, patches, and package-manager policy are already canonical before
  Nix stages them.
- **A02 Pure FOD:** A prepared dependency artifact is a fixed-output data
  artifact and not a live pnpm store.
- **A03 Downstream restore:** Downstream builds consume prepared data by
  restore/projection, not by rerunning dependency installation.

## Acceptable Tradeoffs

- **T01 Staged workspace:** Builders may stage a filtered workspace if the
  staged inputs are mechanically derived from canonical topology inputs.
- **T02 Versioned churn:** Tightening normalization or purity may require a
  prepared artifact version bump and hash refresh. Strict purity transitions
  use one new artifact version instead of report-only or legacy-compatible
  enforcement modes.
- **T03 Explicit native grafts:** Platform-specific native packages may be
  grafted during the platform-specific build phase instead of living in the
  platform-neutral FOD.
- **T04 Opt-in hash churn:** Turning on optional binding inclusion for a root is
  a lockfile-scope change to that root's prepared artifact and moves its
  fixed-output hash. This churn is absorbed by the FOD hash-repair contract
  (`0005`, `01-fod-hash-evidence`) rather than avoided with a parallel
  binding-only artifact.

## Requirements

### Must be deterministic

- **DMP.NIX-R01 Frozen install:** Dependency preparation must run from declared
  inputs with a frozen lockfile and scripts disabled.
  Refines: DMP-R01, DMP-R02, DMP-R05.
- **DMP.NIX-R02 No lockfile repair:** The builder must not resolve, normalize,
  or rewrite the lockfile inside the FOD.
  Refines: DMP-R05, DMP-R15.
- **DMP.NIX-R03 Stable FOD surface:** Equivalent prepared dependency trees must
  hash identically across covered systems unless measured output proves a real
  platform difference.
  Refines: DMP-R18.
- **DMP.NIX-R04 Data-only output:** The prepared artifact must exclude
  projection state, mutable pnpm state, and unclassified native/build outputs.
  Refines: DMP-R05, DMP-R06, DMP-R08.

### Must compose with builds

- **DMP.NIX-R05 Direct boundary:** The prepared dependency artifact must be the
  direct dependency boundary consumed by downstream Nix builds.
  Refines: DMP-R09, DMP-R10.
- **DMP.NIX-R06 Per install root:** Composed workspaces must preserve one
  prepared dependency boundary per Materialization Root unless a single broader
  Materialization Root and Materialization Profile are explicitly measured and
  accepted.
  Refines: DMP-R09, DMP-R11, DMP-R16.
- **DMP.NIX-R07 Restore without install:** Downstream builds must restore the
  prepared artifact and run projection/build steps without rerunning pnpm
  dependency materialization.
  Refines: DMP-R05, DMP-R15.
- **DMP.NIX-R08 Evidence:** Each prepared artifact must emit Materialization
  Profile evidence, purity-scan results, and hash-measurement metadata.
  Refines: DMP-R10, DMP-R18, DMP-R19.
- **DMP.NIX-R11 Optional binding opt-in:** A prepared install root may opt into
  materializing its optional native binding families into the prepared
  artifact. The opt-in is declared per install root and defaults off. When set,
  the artifact must satisfy declared-triple completeness
  (`DMP.NIX.NATIVE-R08`); when unset, the artifact remains binding-free and the
  purity scan rejects native outputs as today.
  Refines: DMP-R04, DMP-R09, DMP.NIX-R04.

### Must remain operational

- **DMP.NIX-R09 Clear stale hash failure:** Stale FOD hashes must fail loudly
  and identify the direct prepared dependency boundary.
  Refines: DMP-R18.
- **DMP.NIX-R10 Observable phases:** Staging, preparation, normalization,
  purity scanning, restore, and downstream build phases must emit stable
  producer facts.
  Refines: DMP-R19.
