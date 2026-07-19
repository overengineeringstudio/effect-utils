# Native Node Package Requirements

## Context

Native Node packages are package families that would normally rely on optional
platform packages, postinstall downloads, source compilation, or generated
native files. effect-utils-managed dependency materialization keeps these out
of lifecycle scripts.

## Assumptions

- **A01 Strict pnpm base:** DMP-R01 through DMP-R04 forbid lifecycle-script
  trust for native dependency realization.
- **A02 Platform identity:** Platform-specific native outputs belong in a
  platform-specific Nix package or a classified pure package artifact.

## Requirements

### Must classify native dependencies

- **DMP.NIX.NATIVE-R01 Explicit family:** Known native package families must
  have an explicit policy classification.
  Refines: DMP-R04, DMP-R08.
- **DMP.NIX.NATIVE-R02 Nix graft:** Native outputs that require compilation,
  downloads, or platform selection through scripts must be supplied by Nix or
  explicit wrappers.
  Refines: DMP-R04.
- **DMP.NIX.NATIVE-R03 Pure artifact exception:** A platform package may remain
  in dependency data only when classified as pure package data for that
  Materialization Profile.
  Refines: DMP-R04, DMP-R08.
- **DMP.NIX.NATIVE-R04 No partial optional smuggling:** Optional dependencies
  must not smuggle a _host-selected subset_ of platform-native outputs into a
  platform-neutral prepared artifact. A prepared artifact may carry an optional
  native family only when the root opts in (`DMP.NIX-R11`) and the family is
  complete across all declared triples (`DMP.NIX.NATIVE-R08`), which keeps the
  artifact platform-neutral and host-invariant.
  Refines: DMP-R05, DMP-R08.

### Must be auditable

- **DMP.NIX.NATIVE-R05 Scan coverage:** Prepared-deps scans must reject
  unexpected native files and known platform package directories.
  Refines: DMP-R08, DMP.NIX-R04.
- **DMP.NIX.NATIVE-R06 Policy drift:** New native package families must fail
  audit until classified.
  Refines: DMP-R08, DMP-R16.
- **DMP.NIX.NATIVE-R07 Runtime wiring:** Downstream wrappers must make native
  runtime dependencies explicit.
  Refines: DMP-R04.

### Must guarantee declared closure completeness

- **DMP.NIX.NATIVE-R08 Declared-triple completeness:** For an install root that
  opts into optional native bindings (`DMP.NIX-R11`), every `pure-package-artifact`
  family present in the resolved (dev + prod) closure must have its binding
  package directory present for every declared `(os, cpu, libc)` triple in the
  prepared artifact. Completeness and rejection (`DMP.NIX.NATIVE-R05`) are one
  scan over one classification: the native dirs the opt-in surfaces must be
  _classified_ — an unclassified family fails per `DMP.NIX.NATIVE-R06`, a
  classified `pure-package-artifact` family must be _complete_ per this
  requirement.
  Refines: DMP.NIX.NATIVE-R03, DMP.NIX.NATIVE-R04, DMP.NIX.NATIVE-R06, DMP-R08.
- **DMP.NIX.NATIVE-R09 Auto-derived family set:** The required-family set must be
  derived from the resolved closure, not from a hand-maintained per-consumer
  list. Consumer input is limited to the opt-in plus reason-carrying waivers.
  Refines: DMP-R08, DMP-R16.
- **DMP.NIX.NATIVE-R10 Loud omission:** A missing declared binding must fail the
  prepared-deps scan and name the family plus the missing triple(s). The
  omission must not be deferred to downstream runtime binding resolution.
  Refines: DMP.NIX-R09, DMP.NIX.NATIVE-R05.
- **DMP.NIX.NATIVE-R11 Reason-carrying waiver:** A family/triple with no
  published prebuilt, or provably not build-loaded, may be waived only through
  an explicit reason-carrying waiver. A waiver must not silently expand to
  families it does not name.
  Refines: DMP-R08.
