# Store Authority Requirements

## Context

Store authority defines which dependency state may be shared and who may
repair, prune, or garbage-collect it. It refines DMP-R12 through DMP-R15.

## Assumptions

- **A01 pnpm Store Cache:** A pnpm Store Cache contains immutable
  content-addressed package files and pnpm-owned mutable derived indexes. Both
  are disposable cache state; neither is Dependency Graph authority.
  The mutable indexes do not satisfy the pure cross-root reuse boundary.
- **A02 Local trust boundary:** Local development roots that share a Store
  Cache run as one mutually trusted operating-system user.
- **A03 Safety-gated reuse objective:** Cross-worktree reuse is optimized only
  after dependency identity, purity, data safety, graph ownership, concurrency,
  and bounded repair scope are satisfied as hard constraints.

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
  virtual topology, and Projection State must be owned by exactly one
  Materialization Root and independently discardable without coordinating
  sibling roots. A storage-reuse mechanism must not expand that authority scope.
  Refines: DMP-R12.
- **DMP.STORE-R03 Maximal safe cache reuse:** Local development must maximize
  cross-root reuse of eligible immutable package data within one declared trust
  boundary. Mutable package-manager indexes must remain outside the claimed
  reusable layer. Duplicate immutable-data realizations require measured
  justification and must not become graph, lifecycle, repair, or availability
  authority.
  Refines: DMP-R12, DMP-R13, DMP-R21, DMP-R22, DMP-R23.
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
  share a Store Cache must retain independent root-local locks and graphs and
  must not serialize independent roots without evidence that the cache owner's
  native concurrency boundary is insufficient.
  Refines: DMP-R12, DMP-R15.
- **DMP.STORE-R09 Capability-optimal import:** Managed live installs must select
  the most reuse-efficient import mechanism proven compatible with the host
  filesystem and purity boundary. Imported package files are immutable by
  contract; verification must disclose effective byte/inode aliasing rather
  than claiming unconditional physical isolation.
  Refines: DMP-R01, DMP-R12, DMP-R21, DMP-R22.
- **DMP.STORE-R10 Zero-copy invariant:** A local install that claims zero-copy
  reuse must prove its placement and filesystem prerequisites before mutation
  and fail closed instead of silently degrading to per-root byte duplication.
  Refines: DMP-R12, DMP-R22.
- **DMP.STORE-R11 CI job cache:** CI installs must use a job-local Store Cache;
  one job's cleanup must not mutate another job's
  cache or graph.
  Refines: DMP-R12, DMP-R13.
- **DMP.STORE-R12 Independent Nix cache:** Nix prepared-dependency production
  must use its builder-owned immutable/content-addressed boundary rather than
  mutable live host cache state.
  Refines: DMP-R05, DMP-R09, DMP-R21, DMP-R23.

### Must be measured

- **DMP.STORE-R13 Benchmark evidence:** Changes to storage placement, sharing,
  or import method must report the comparison evidence defined by the
  verification subsystem.
  Refines: DMP-R16.
- **DMP.STORE-R14 Default gate:** A sharing or import strategy may become
  default only after satisfying the hard gates in DMP-R21 through DMP-R23 and
  proving a non-dominated operating point among evaluated admissible candidates
  on real workspaces across physical bytes, repeated work, latency, concurrency,
  and operational complexity. New admissible candidates remain challengers.
  Refines: DMP-R16, DMP-R21, DMP-R22, DMP-R23.
- **DMP.STORE-R15 Bounded host lifecycle:** The host Store Cache owner must
  measure cache bytes periodically and under pressure. Destructive reclamation
  may be enabled only when evidence proves it cannot invalidate live roots;
  otherwise it remains measurement-only. Every run must report cache bytes,
  reclaimed bytes, outcome, and dry-run mode. Maintenance must exclude cache
  mutation without serializing independent installs against one another.
  Refines: DMP-R13, DMP-R14, DMP-R15.
- **DMP.STORE-R16 Explicit legacy-cache migration:** A legacy Store Cache that
  bridges package data outside its selected ownership boundary must fail closed
  during normal installs. Only an explicit, idempotent cache-owner migration may
  transform a recognized legacy shape; unknown state and the external legacy
  data source must remain untouched.
  Refines: DMP-R13, DMP-R14, DMP-R15.
