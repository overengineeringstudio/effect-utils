# Buck2 Realization Requirements

## Context

These requirements define the Buck2 realization of dependency materialization:
declared evidence, hermetic dependency/product artifacts, and build authority
for the consumers within its scope.

## Assumptions

- **A01 Materialization Profile identity:** Buck2 evidence consumes the shared
  DMP Materialization Profile identity.
- **A02 System boundary:** Nix retains host tooling, activation, deployment,
  services, secrets, and system wrappers. Live mutable pnpm install and repair
  remain outside Buck2 actions.

## Acceptable Tradeoffs

- **T01 Evidence-only targets:** A Buck2 target may emit Materialization Profile
  evidence without materializing dependencies when it does not claim artifact
  or build authority for that consumer.

## Requirements

### Must be declared graph input

- **DMP.BUCK-R01 Declared inputs:** Buck2 targets must depend on declared
  dependency inputs or immutable artifacts, not ambient pnpm store contents.
  Refines: DMP-R09, DMP-R10.
- **DMP.BUCK-R02 Stable evidence:** Evidence must include Materialization Profile
  identity, policy digest, input digests, materialization authority, and artifact
  identity when an artifact is produced.
  Refines: DMP-R10.
- **DMP.BUCK-R03 No secret keys:** Evidence must not include credentials or
  host-private paths.
  Refines: DMP-R10.

### Must preserve authority boundaries

- **DMP.BUCK-R04 No ambient ownership:** Buck2 actions must not silently depend
  on or mutate a live pnpm install, shared store, host cache, GC, or repair
  surface.
  Refines: DMP-R11, DMP-R12.
- **DMP.BUCK-R05 Hermetic artifact contract:** A Buck2 dependency builder must
  declare the complete Materialization Profile inputs and prove that its output
  satisfies the consumer-level dependency/product contract.
  Refines: DMP-R10, DMP-R16.
- **DMP.BUCK-R06 Single build authority:** For every consumer in the declared
  Buck2 scope, Buck2 must be the only build authority for repo-local
  compilation, generation, tests, bundles, and dependency/product artifacts.
  Other mechanisms may provide declared inputs or consume outputs, but must not
  independently rebuild the same artifact contract.
  Refines: DMP-R11, DMP-R24.
