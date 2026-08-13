# Rust Target Execution Requirements

## Context

Rust target execution refines the shared
[target execution requirements](../requirements.md) for first-party crates,
Cargo ecosystem metadata, Reindeer-generated external targets, Prelude Rust
actions, and deployable native binaries.

## Assumptions

- **BUCK.EXEC.RUST-A01 Shared execution contract:** The common target envelope,
  declared-action, tool-provider, quality, platform, and evidence requirements
  are inherited from `BUCK.EXEC-R01` through `BUCK.EXEC-R17`.
- **BUCK.EXEC.RUST-A02 Cargo ecosystem interface:** Cargo-compatible manifests
  and locks remain the dependency-request and ecosystem-tooling interface even
  when Cargo process execution is not terminal build authority.
- **BUCK.EXEC.RUST-A03 Prelude compilation:** Native Prelude Rust rules are the
  compilation primitive. Repository-owned adapters add only semantics or
  validation surfaces not carried by those providers.

## Acceptable Tradeoffs

- **BUCK.EXEC.RUST-T01 Resolver-root projection:** A synthetic Reindeer root
  manifest and lock may exist when Reindeer cannot project required root
  dependency scopes directly, provided the manifest is mechanically derived
  and the lock is proven equivalent outside the synthetic root identity.
- **BUCK.EXEC.RUST-T02 Explicit support matrix:** Buck Rust authority may cover
  a strict subset of Cargo-expressible platforms when the admitted matrix is
  explicit and every other platform fails closed.

## Requirements

### Must preserve first-party crate intent

- **BUCK.EXEC.RUST-R01 Crate model:** The Rust adapter must represent package
  metadata, edition, library, binaries, tests, first-party build scripts,
  profiles, dependency scopes and features, target predicates, compile
  environment, runtime resources, and tool requirements.
  Refines: BUCK.EXEC-R01, BUCK.EXEC-R03.
- **BUCK.EXEC.RUST-R02 Target variants:** Libraries, binaries, unit tests,
  integration tests, documentation tests, and first-party build scripts must be
  distinct semantic target variants with valid roots and dependency scopes.
  Refines: BUCK.EXEC-R01, BUCK.EXEC-R05, BUCK.EXEC-R10.

### Must preserve the Cargo and Reindeer boundary

- **BUCK.EXEC.RUST-R04 Resolver authority:** Cargo lock state together with
  Reindeer configuration, fixups, and vendored source integrity exclusively
  determines selected external versions, checksums, features, target-conditioned
  edges, proc macros, and third-party build-script targets.
  Refines: BUCK.EXEC-R04, BUCK.EXEC-R06.
- **BUCK.EXEC.RUST-R05 Stable alias consumption:** First-party targets must
  consume stable Reindeer aliases validated against declared normal, dev, or
  build dependency scope. They must not reproduce selected transitive topology.
  Refines: BUCK.EXEC-R03, BUCK.EXEC-R07.
- **BUCK.EXEC.RUST-R06 Resolver freshness:** The generated Reindeer graph,
  vendor set, fixups, resolver-root projection, and non-root lock equivalence
  must fail closed when stale or inconsistent.
  Refines: BUCK.EXEC-R04, BUCK.EXEC-R15.
- **BUCK.EXEC.RUST-R07 Maintenance-only Cargo:** Cargo and Reindeer processes
  may run in named dependency-regeneration and freshness workflows, but must not
  execute inside admitted build, lint, format, test, documentation-test, or
  package actions.
  Refines: BUCK.EXEC-R06.

### Must reproduce Rust execution semantics

- **BUCK.EXEC.RUST-R08 Build-script fidelity:** Supported build scripts must be
  explicit actions whose emitted cfg, environment, link directives, search
  paths, generated files, declared rerun inputs, and target/exec platform
  behavior match the admitted Cargo reference.
  Refines: BUCK.EXEC-R03, BUCK.EXEC-R04, BUCK.EXEC-R15.
- **BUCK.EXEC.RUST-R09 Proc-macro fidelity:** Proc macros must execute for the
  execution platform while their consumers compile for the target platform,
  with both toolchain identities declared.
  Refines: BUCK.EXEC-R11, BUCK.EXEC-R14.
- **BUCK.EXEC.RUST-R10 Toolchain closure:** Rust compiler, rustdoc,
  clippy-driver, rustfmt, target standard libraries, linker, C/C++ compiler,
  archiver, and build-script utilities must be declared compatible provider
  inputs.
  Refines: BUCK.EXEC-R11, BUCK.EXEC-R14.

### Must make Buck the terminal Rust authority

- **BUCK.EXEC.RUST-R11 Test fidelity:** Unit, integration, documentation,
  property, golden, and process-level harnesses must expose exact inventories,
  resources, environment, and pass/fail results through Buck.
  Refines: BUCK.EXEC-R08, BUCK.EXEC-R10.
- **BUCK.EXEC.RUST-R12 Clippy authority:** Clippy diagnostics must be validated
  under repository policy and fail the Buck quality gate when prohibited;
  infallible diagnostic production is not a passing result.
  Refines: BUCK.EXEC-R08, BUCK.EXEC-R09.
- **BUCK.EXEC.RUST-R13 Rustfmt authority:** Rust formatting must be checked by a
  declared, toolchain-pinned Buck action that does not rewrite source inputs.
  Refines: BUCK.EXEC-R08, BUCK.EXEC-R11.
- **BUCK.EXEC.RUST-R14 Rustdoc authority:** Documentation compilation and
  documentation tests must run through Buck or produce an explicit verified
  zero-applicability result.
  Refines: BUCK.EXEC-R08, BUCK.EXEC-R10.
- **BUCK.EXEC.RUST-R15 Converged build authority:** For every admitted Rust
  package and platform, Buck must be the sole terminal authority for build,
  lint, format, tests, documentation tests, build scripts, normalization, and
  deployable artifact production. Cargo remains metadata and maintenance input;
  deployment convergence verifies and imports the Buck artifact rather than
  rebuilding repository sources.
  Refines: BUCK.EXEC-R05, BUCK.EXEC-R08, BUCK.EXEC-R17.
- **BUCK.EXEC.RUST-R16 Support-tool relationship:** Rust actions that use the
  shared support tool must consume the stage0 or promoted provider defined by
  the parent contract. Rust target execution must not own that tool's platform
  realization or create a dependency cycle through the Rust toolchain it
  helps realize.
  Refines: BUCK.EXEC-R12, BUCK.EXEC-R13.
