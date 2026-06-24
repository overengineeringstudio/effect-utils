# Dependency Materialization Requirements

## Context

These requirements define the dependency materialization contract used by
effect-utils live pnpm tasks, Nix prepared dependency artifacts, CI jobs, and
future Buck2 dependency evidence.

The contract is intentionally stricter than pnpm's default lifecycle model:
pnpm resolves and links package contents, while executable projection, native
tooling, and repair are owned by effect-utils, Nix, or explicit profile
operations.

Subsystem requirements refine this root contract:

- [01-live-pnpm](./01-live-pnpm/requirements.md) defines mutable worktree
  installs and topology ownership.
- [02-projections](./02-projections/requirements.md) defines deterministic
  executable and workspace projection.
- [03-nix-prepared-deps](./03-nix-prepared-deps/requirements.md) defines
  immutable Nix prepared dependency artifacts.
- [04-store-authority](./04-store-authority/requirements.md) defines shared
  content, repair, prune, and GC authority.
- [05-buck2-evidence](./05-buck2-evidence/requirements.md) defines the Buck2
  evidence boundary.
- [06-observability](./06-observability/requirements.md) defines producer facts
  for materialization telemetry.
- [07-verification](./07-verification/requirements.md) defines the proof,
  benchmark, and regression architecture for dependency materialization.

## Assumptions

- **A01 pnpm base:** The supported package-manager surface is pnpm 11 with the
  repo's canonical workspace topology and lockfile.
- **A02 Nix authority:** Native tools, compiled native bindings, and runtime
  binaries that cannot be treated as pure package artifacts are supplied by Nix
  or explicit wrappers, not by pnpm lifecycle scripts.
- **A03 Profile consumers:** Live installs, Nix prepared dependency artifacts,
  CI jobs, and Buck2 evidence may realize dependencies differently, but they use
  one shared profile vocabulary for identity, policy, and authority.
- **A04 Prepared artifacts are data:** Prepared pnpm dependency FODs are data
  artifacts. Build-time executable shims and native/build outputs are
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
  refreshes.
- **T04 Conservative repair:** Repair and GC commands may refuse to mutate when
  they cannot prove the correct profile, platform, or shared-store authority.

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
- **DMP-R04 Native purity:** Native dependencies must be represented as Nix
  inputs, explicit wrappers, or pure package artifacts selected without running
  lifecycle scripts.

### Must separate dependency data from projections

- **DMP-R05 Prepared FOD data surface:** A prepared pnpm dependency artifact
  must contain only deterministic dependency data required by downstream
  restores. It must not archive mutable pnpm store/home/state paths.
- **DMP-R06 Bin projection ownership:** `node_modules/.bin` entries are
  executable projection state. They must be created, checked, and repaired by a
  deterministic projection step rather than by dependency lifecycle scripts.
- **DMP-R07 Pure bin linking:** Bin projection must derive expected executables
  from installed package manifests and lock/projection metadata, and must not
  execute package code.
- **DMP-R08 Native output rejection:** Prepared dependency validation must
  reject unexpected compiled native outputs and known platform-specific package
  directories unless the profile explicitly classifies them as pure package
  data.

### Must make materialization identity explicit

- **DMP-R09 Profile identity:** Every dependency materialization root must have
  a stable profile identity derived from topology, lockfile, package-manager
  policy, toolchain inputs, platform trait, and projection namespace.
- **DMP-R10 Shared schema:** Live pnpm tasks, Nix prepared dependency artifacts,
  CI jobs, and Buck2 evidence must use the same profile fields when describing
  equivalent dependency work.
- **DMP-R11 Topology authority:** A profile must name the authoritative
  workspace topology and install owner. Package-local or sibling-root install
  state must not become authoritative implicitly.

### Must preserve correctness under sharing

- **DMP-R12 Store trait:** A profile must declare one store trait such as
  `ciJobLocal`, `darwinSplitCas`, `linuxSharedHardlink`, `isolated`,
  `nixPreparedDeps`, or a proven future trait.
- **DMP-R13 Shared CAS safety:** Any content-addressed store shared by multiple
  profiles may be swept only by an authority that can mark from every active
  root that references the shared pool.
- **DMP-R14 Raw prune refusal:** A per-profile prune command must refuse to
  mutate a shared files pool unless it is executing through the shared pool's
  coordinated GC authority.
- **DMP-R15 Repair determinism:** Repair commands must converge to the same
  final dependency data and projection state for the same profile inputs.

### Must be measured and verifiable

- **DMP-R16 Real-repo gates:** Changes to store traits, prepared artifact
  purity, or projection ownership must be validated on at least one real
  downstream graph in addition to synthetic fixtures.
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
