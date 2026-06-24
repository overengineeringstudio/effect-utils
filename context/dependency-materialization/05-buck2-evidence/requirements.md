# Buck2 Evidence Requirements

## Context

Buck2 evidence is the initial Buck2 boundary for dependency materialization.
Buck2 may consume deterministic dependency facts before it owns hermetic
dependency building or host-local pnpm repair.

## Assumptions

- **A01 Profile authority:** Buck2 evidence consumes the shared DMP profile
  identity.
- **A02 No live repair:** Live mutable pnpm install and repair remain outside
  Buck2 until a hermetic action is proven.

## Acceptable Tradeoffs

- **T01 Evidence first:** Buck2 may start with profile evidence targets instead
  of full dependency materialization targets.

## Requirements

### Must be declared graph input

- **DMP.BUCK-R01 Declared inputs:** Buck2 targets must depend on declared
  dependency inputs or immutable artifacts, not ambient pnpm store contents.
  Refines: DMP-R09, DMP-R10.
- **DMP.BUCK-R02 Stable evidence:** Evidence must include profile identity,
  policy digest, input digests, and materialization authority.
  Refines: DMP-R10.
- **DMP.BUCK-R03 No secret keys:** Evidence must not include credentials or
  host-private paths.
  Refines: DMP-R10.

### Must preserve authority boundaries

- **DMP.BUCK-R04 No live ownership:** Buck2 evidence targets must not silently
  run live pnpm install, shared-store GC, or repair.
  Refines: DMP-R11, DMP-R12.
- **DMP.BUCK-R05 Future hermetic path:** A future Buck2 dependency builder must
  declare the same profile inputs and prove output equivalence against the Nix
  or live profile realization it replaces.
  Refines: DMP-R10, DMP-R16.
