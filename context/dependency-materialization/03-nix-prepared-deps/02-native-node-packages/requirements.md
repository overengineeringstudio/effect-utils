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
  profile.
  Refines: DMP-R04, DMP-R08.
- **DMP.NIX.NATIVE-R04 No optional smuggling:** Optional dependencies must not
  smuggle platform-native outputs into platform-neutral prepared artifacts.
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
