# Store Authority Requirements

## Context

Store authority defines which dependency state may be shared and who may
repair, prune, or garbage-collect it. It refines DMP-R12 through DMP-R15.

## Assumptions

- **A01 pnpm Store Cache:** A pnpm Store Cache contains immutable
  content-addressed package files and pnpm-owned mutable derived indexes. Both
  are disposable cache state; neither is Dependency Graph authority.
- **A02 Local trust boundary:** Local development roots that share a Store
  Cache run as one mutually trusted operating-system user.
- **A03 Sharing is valuable:** Cross-worktree Store Cache reuse is a desired
  optimization when graph ownership, concurrency, and import semantics remain
  explicit.

## Acceptable Tradeoffs

- **T01 Fail-closed zero-copy:** A local install may refuse to materialize when
  its selected zero-copy import method cannot be honored safely.
- **T02 CI isolation:** CI may give up host-wide cache reuse to keep concurrent
  jobs and their cleanup independent.
- **T03 Independent Nix path:** Live-install cache placement need not match Nix
  prepared-dependency storage because Nix provides its own content-addressed
  reuse boundary.
- **T04 Same-user hardlink aliasing:** On a filesystem where pnpm `auto`
  selects hardlinks, a direct write through one imported dependency aliases the
  Store Cache and sibling roots. This is accepted only inside the declared
  mutually trusted same-user boundary; managed installs must keep lifecycle
  mutation disabled and must preserve build-sensitive package isolation.

## Requirements

### Must declare authority

- **DMP.STORE-R01 Independent storage facts:** Evidence and configuration must
  state graph scope, Store Cache scope, import method, and system applicability
  as independent facts rather than one preset or profile name.
  Refines: DMP-R12.
- **DMP.STORE-R02 Root-local graph owner:** Writable Dependency Graph state,
  the pnpm virtual store, and Projection State must be owned by exactly one
  Materialization Root. Managed installs must disable pnpm's Global Virtual
  Store and keep `node_modules/.pnpm` inside that root.
  Refines: DMP-R12.
- **DMP.STORE-R03 Host Store Cache:** Local development must reuse one
  host-scoped pnpm Store Cache across mutually trusted Materialization Roots,
  including its content-addressed files and pnpm-owned derived index.
  Refines: DMP-R12, DMP-R13.
- **DMP.STORE-R04 Root operation boundary:** An effect-utils-managed operation
  scoped to one Materialization Root must not prune or sweep a host-scoped
  Store Cache.
  Refines: DMP-R14.

### Must be safe and repairable

- **DMP.STORE-R05 Explicit offline readiness:** Materialization Root health must
  not imply Store Cache completeness. Any offline-readiness claim must name its
  declared inputs and carry separate no-network evidence.
  Refines: DMP-R13, DMP-R19.
- **DMP.STORE-R06 Deterministic root repair:** Repair must rebuild from declared
  inputs without rewriting lockfiles, mutating sibling roots, or pruning the
  Store Cache.
  Refines: DMP-R14, DMP-R15.
- **DMP.STORE-R07 Low-disk safety:** Managed materialization must check its
  writable storage boundary before creating a second dependency realization
  and must fail explicitly when the configured free-space floor is not met.
  Refines: DMP-R15.
- **DMP.STORE-R08 Concurrent cache mutation:** Concurrent managed installs that
  share a Store Cache must use pnpm's proven store-concurrency boundary while
  retaining independent root-local locks and graphs. Managed callers must not
  add a host-wide install lock without evidence of a pnpm concurrency defect.
  Refines: DMP-R12, DMP-R15.
- **DMP.STORE-R09 Native import policy:** Managed live installs must use pnpm's
  `auto` package import policy so the package manager selects clone, hardlink,
  or copy according to filesystem capability. Imported package files remain
  immutable under the lifecycle policy, and verification must disclose the
  effective inode-alias behavior rather than claiming unconditional isolation.
  Refines: DMP-R01, DMP-R12.
- **DMP.STORE-R10 Linux device invariant:** Before a Linux local install uses
  zero-copy imports, it must prove that the Store Cache package files and
  Materialization Root are on the same filesystem device and fail closed when
  they are not.
  Refines: DMP-R12.
- **DMP.STORE-R11 CI job cache:** CI installs must use a job-local Store Cache;
  one job's cleanup must not mutate another job's
  cache or graph.
  Refines: DMP-R12, DMP-R13.
- **DMP.STORE-R12 Independent Nix cache:** Nix prepared-dependency production
  must use its builder-owned store and import policy rather than the live
  host-scoped Store Cache.
  Refines: DMP-R05, DMP-R09.

### Must be measured

- **DMP.STORE-R13 Benchmark evidence:** Changes to storage placement, sharing,
  or import method must report the comparison evidence defined by the
  verification subsystem.
  Refines: DMP-R16.
- **DMP.STORE-R14 Default gate:** A sharing or import strategy may become
  default only after proving correctness and material cache-efficiency gains on
  real workspaces.
  Refines: DMP-R16.
