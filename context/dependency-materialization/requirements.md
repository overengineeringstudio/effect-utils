# Dependency Materialization Requirements

## Context

These requirements define the dependency materialization contract used by
effect-utils live pnpm tasks, immutable dependency artifacts, CI jobs, and
declared repo-local build actions.

Canonical shared terms and relationships are defined in
[ontology.md](./ontology.md).

The contract is intentionally stricter than pnpm's default lifecycle model:
pnpm resolves and links package contents, while executable projection, native
tooling, and repair are owned by effect-utils, Nix, or an explicit realization
authority.

Subsystem requirements refine this root contract:

- [01-live-pnpm](./01-live-pnpm/requirements.md) defines mutable worktree
  installs and topology ownership.
- [02-projections](./02-projections/requirements.md) defines deterministic
  executable and local metadata projection.
- [03-nix-prepared-deps](./03-nix-prepared-deps/requirements.md) defines
  immutable Nix prepared dependency artifacts.
- [04-store-authority](./04-store-authority/requirements.md) defines shared
  content, repair, prune, and GC authority.
- [05-buck2-evidence](./05-buck2-evidence/requirements.md) defines the Buck2
  realization and evidence boundary.
- [06-observability](./06-observability/requirements.md) defines producer facts
  for materialization telemetry.
- [07-verification](./07-verification/requirements.md) defines the proof,
  benchmark, and regression architecture for dependency materialization.
- [08-ci-store-cache](./08-ci-store-cache/requirements.md) defines the CI-profile
  pnpm store persistence contract: workspace-relative store placement, versioned
  per-repo cache keys, and single-publisher write coordination.

## Assumptions

- **A01 pnpm base:** The supported package-manager surface is pnpm 11 with the
  repo's canonical workspace topology and lockfile.
- **A02 System integration authority:** Native tools, compiled native bindings,
  and runtime binaries that cannot be treated as pure package artifacts are
  supplied by explicit system inputs or wrappers, not by pnpm lifecycle scripts.
- **A03 Materialization Profile consumers:** Immutable dependency artifacts and
  build evidence use one Materialization Profile vocabulary for equivalent
  dependency inputs. Live installs use their declared inputs and install
  contract directly.
- **A04 Dependency artifacts are data:** Immutable dependency artifacts contain
  dependency data. Build-time executable shims and native/build outputs are
  projection or build-layer concerns unless explicitly modeled as pure package
  data.

## Acceptable Tradeoffs

- **T01 Stricter compatibility:** Packages that require postinstall downloads,
  source compilation, or generated CLI files may fail until a Nix or pure
  prebuilt integration exists.
- **T02 Projection work after install:** The system may perform deterministic
  post-install projection, such as `.bin` linking, when the projection reads
  package metadata and writes local shims without executing package code.
- **T03 Versioned artifact churn:** Tightening prepared artifact purity may
  require a prepared-deps artifact version bump and broad fixed-output hash
  refreshes. When a purity boundary is deliberately tightened, a single
  convergent version bump is preferred over maintaining parallel legacy
  prepared-deps policies.
- **T04 Conservative repair:** Repair and GC commands may refuse to mutate when
  they cannot identify the Materialization Root or prove the required
  shared-content authority.
- **T05 Purity before reuse:** Work that cannot be derived deterministically
  from declared inputs without lifecycle mutation remains outside the shared
  reuse boundary, even when isolating or rebuilding it costs more time or disk.

## Requirements

### Must keep pnpm materialization pure

- **DMP-R01 Lifecycle scripts forbidden:** Live pnpm installs and prepared
  dependency builds must run with lifecycle scripts disabled.
- **DMP-R02 Override rejection:** Managed install entrypoints must reject user
  or workspace overrides that re-enable dependency lifecycle scripts, package
  builds, or package-manager approval flows.
- **DMP-R03 No approve-builds gate:** `allowBuilds`, `onlyBuiltDependencies`,
  `pnpm approve-builds`, and related pnpm build-approval mechanisms must not be
  the primary trust boundary for effect-utils-managed installs.
- **DMP-R04 Native purity:** Native dependencies must be represented as explicit
  system inputs, wrappers, or pure package artifacts selected without running
  lifecycle scripts.

### Must separate dependency data from projections

- **DMP-R05 Dependency artifact data surface:** An immutable dependency artifact
  must contain only deterministic dependency data required by declared
  consumers. It must not archive mutable package-manager store, home, or state
  paths.
- **DMP-R06 Bin projection ownership:** `node_modules/.bin` entries are
  executable projection state. They must be created, checked, and repaired by a
  deterministic projection step rather than by dependency lifecycle scripts.
- **DMP-R07 Pure bin linking:** Bin projection must derive expected executables
  from installed package manifests and lock/projection metadata, and must not
  execute package code.
- **DMP-R08 Native output rejection:** Prepared dependency validation must
  reject unexpected compiled native outputs and known platform-specific package
  directories unless the Materialization Profile explicitly classifies them as
  pure package data.

### Must make materialization identity explicit

- **DMP-R09 Materialization Profile identity:** When an immutable artifact or
  build-evidence target groups equivalent dependency work, its stable
  Materialization Profile identity must derive from topology, dependency inputs,
  package-manager policy, and toolchain inputs, not physical root or storage
  placement.
- **DMP-R10 Shared Materialization Profile schema:** Artifact producers and
  build-evidence targets must use the same Materialization Profile fields when
  describing equivalent dependency work.
- **DMP-R11 Topology and edge authority:** Each Materialization Root must name
  authoritative workspace topology and exactly one Authoritative Materializer.
  The repository must also declare exactly one build authority for repo-local
  compilation, generation, tests, bundles, and dependency/product artifacts.
  Package-local or sibling-root state must not become authoritative implicitly.
  Only the Authoritative Materializer may select or change the Package Instance
  targeted by a Dependency Edge. A faithful restore may reproduce an
  already-selected edge, and repair may discard an owned realization and
  reinvoke the Authoritative Materializer; neither may select a replacement
  target.

### Must preserve correctness under sharing

- **DMP-R12 Root-owned writable state:** Writable Dependency Graph, virtual
  store, and Projection State must remain inside one Materialization Root.
  Cross-root reusable state must satisfy DMP-R21; package-manager control-plane
  metadata is not made pure merely by being disposable or non-authoritative.
- **DMP-R13 Store Cache safety:** Loss or eviction of a Store Cache must not
  corrupt an already-materialized Dependency Graph. Cache completeness must
  not be treated as root health or as an offline-readiness guarantee.
- **DMP-R14 Managed prune refusal:** An effect-utils-managed prune scoped to one
  Materialization Root must not mutate a host-scoped Store Cache.
- **DMP-R15 Repair determinism:** Repair commands must converge to the same
  final Dependency Graph, Dependency Data, and Projection State for the same
  declared dependency inputs and materialization policy.

### Must be measured and verifiable

- **DMP-R16 Real-repo gates:** Changes to build authority, storage sharing,
  artifact purity, or projection ownership must be validated on at least one
  real downstream graph in addition to synthetic fixtures.
- **DMP-R17 Negative lifecycle tests:** Test fixtures must prove that managed
  install plus projection does not run `preinstall`, `install`, `postinstall`,
  `prepare`, rebuild, or approval paths.
- **DMP-R18 Artifact hash discipline:** Shared fixed-output hashes may be used
  only when all covered systems are measured or explicitly marked pending by
  metadata that prevents accidental collapse or split.
- **DMP-R19 Observable phases:** Materialization, normalization, projection,
  repair, GC, and evidence production must emit enough timing and size facts to
  explain regressions.
- **DMP-R20 Verification architecture:** Changes to dependency materialization
  behavior must map to explicit fixture, proof, benchmark, or real-workload
  evidence before they become defaults.

### Must maximize reuse inside a pure boundary

- **DMP-R21 Pure reusable state:** Cross-root reusable state must be
  deterministic, content-addressed or equivalently integrity-addressed, derived
  only from declared inputs, and treated as immutable. Dependency lifecycle
  scripts, ambient downloads, source compilation, and mutable native/build
  outputs must not enter that reuse boundary.
- **DMP-R22 Safety-gated optimization:** Correct dependency identity, declared
  graph authority, lifecycle purity, data safety, and bounded repair/failure
  scope are hard admissibility constraints. Among designs that satisfy every
  constraint, defaults must seek a non-dominated operating point across
  physical bytes, repeated work, cold/warm latency, concurrency, and operational
  complexity among evaluated admissible candidates rather than maximizing
  shared mutable state. New admissible candidates remain open challengers.
- **DMP-R23 Reuse/authority separation:** Reuse Scope and Authority Scope must
  remain independent. Equivalent immutable data or work may be reused as
  broadly as evidence permits, while writable graph, projection, repair, and
  lifecycle authority stays at the smallest independently recoverable scope.
- **DMP-R24 Hermetic topology reuse:** Repeated dependency resolution or
  topology work must graduate into a cross-root reusable artifact only when
  its complete identity is derived from declared inputs, construction is
  lifecycle-free and atomic, consumers cannot mutate the result, and corruption
  or eviction can be repaired without coordinating those consumers. Root-local
  mutable realization is a compatibility boundary, not the long-term reuse
  ideal. A reusable artifact producer must not create a parallel build authority.
