# Rust Target Execution Spec

This document specifies Rust target execution. It refines the shared
[target execution spec](../spec.md) and satisfies
[requirements.md](./requirements.md).

Status: **Draft**

## Scope

This specification defines first-party crate intent, its Cargo and Reindeer
boundary, Prelude target construction, Rust quality actions, build scripts,
proc macros, support-tool consumption, and terminal artifact authority. It does
not define Cargo's resolution algorithm, Reindeer's generated third-party rule
internals, Nix tool recipes, platform realization, or system activation.

The upstream
[Rust Cargo authoring binding](../../01-semantic-graph/01-authoring-bindings/02-rust-cargo/spec.md)
owns Cargo-manifest interpretation and the repository operation overlay. This
subsystem consumes normalized Rust targets and stable selected dependency
aliases.

## Requirement Trace

| Spec section                 | Requirements                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------ |
| First-party Rust model       | BUCK.EXEC.RUST-R01, BUCK.EXEC.RUST-R02                                         |
| Cargo and Reindeer boundary  | BUCK.EXEC.RUST-R04, BUCK.EXEC.RUST-R05, BUCK.EXEC.RUST-R06, BUCK.EXEC.RUST-R07 |
| Prelude execution graph      | BUCK.EXEC.RUST-R08, BUCK.EXEC.RUST-R09, BUCK.EXEC.RUST-R10                     |
| Quality surfaces             | BUCK.EXEC.RUST-R11, BUCK.EXEC.RUST-R12, BUCK.EXEC.RUST-R13, BUCK.EXEC.RUST-R14 |
| Convergence and support tool | BUCK.EXEC.RUST-R15, BUCK.EXEC.RUST-R16                                         |

## First-Party Rust Model

```text
RustPackageIntent
  |-- Cargo package metadata and dependency requests
  |-- library and binary targets
  |-- unit, integration, and documentation tests
  |-- first-party build scripts
  `-- profiles, resources, environment, and tool capabilities
```

The execution adapter consumes a closed normalized model:

```typescript
type RustTarget = RustLibrary | RustBinary | RustTest | RustBuildScript

interface RustCompileIntent {
  readonly crate: string
  readonly crateRoot: RepoRelativePath
  readonly edition: RustEdition
  readonly sources: readonly RepoRelativePath[]
  readonly firstPartyDeps: readonly TargetLabel[]
  readonly externalDeps: RustDependencyRootPolicy
  readonly env: Readonly<Record<string, string>>
}

type RustDependencyUse = {
  readonly alias: string
  readonly scope: 'normal' | 'dev' | 'build'
}

type RustDependencyRootPolicy =
  | { readonly kind: 'exact'; readonly uses: readonly RustDependencyUse[] }
  | { readonly kind: 'cargo-scope'; readonly scope: 'normal' | 'dev' | 'build' }

interface RustTest extends RustCompileIntent {
  readonly kind: 'test'
  readonly harness: 'unit' | 'integration' | 'documentation'
  readonly resources: readonly TargetLabel[]
  readonly runtimeTools: readonly ToolCapability[]
}
```

The authoring binding supplies normalized crate identity, targets, and admitted
dependency-root policies. Each execution target remains explicit about sources,
environment, and resources. Validation rejects an unavailable selected alias,
a build dependency used by ordinary compilation, an integration resource
without a declared first-party target, conflicting crate identities, and an
unsupported configured platform. Execution does not reinterpret Cargo
manifests to repair a rejected authoring contribution.

## Cargo and Reindeer Boundary

```text
canonical Cargo request authority
  |-- authored or canonically projected Cargo manifest
  |-- resolver-root request projection, when required
  `-- first-party package-local BUCK

Cargo lock + Reindeer config + fixups + vendored sources
  `-- selected third-party BUCK graph and stable aliases

first-party BUCK --alias references--> selected third-party graph
```

The Rust Cargo binding supplies canonical direct request identities and admitted
root policies. Any synthetic Reindeer root manifest is a deterministic
dependency-maintenance projection of the same Cargo authority rather than a
parallel handwritten map.

Cargo owns lock selection semantics. Reindeer consumes the manifest and lock,
applies its configuration and fixups, verifies or vendors source archives, and
emits selected Buck targets, aliases, target-conditioned edges, proc macros,
and third-party build-script rules. The first-party adapter sees only the
stable alias namespace and does not copy selected versions, checksums,
transitive edges, build-script details, or fixup data.

When a synthetic resolver root is required, dependency scopes are projected by
documented policy. A freshness validator compares canonical intent with both
manifests and proves that canonical and resolver-root locks contain equivalent
non-root package records, including source, version, checksum, and dependency
edges. Only the deliberately different synthetic root identity may differ.

Cargo and Reindeer executables are permitted in graph-regeneration and
freshness workflows. Their outputs are committed, deterministic, provenance
marked, and checked for byte identity. No authoritative language action invokes
Cargo for compilation, testing, linting, formatting, documentation, build
scripts, or packaging.

## Prelude Execution Graph

```text
Reindeer aliases + first-party sources + Rust toolchain
                         |
         +---------------+----------------+
         v               v                v
    rust_library     rust_binary       rust_test
         ^                                ^
         |                                |
 build-script outputs --------------------+

proc macro: execution platform
consumer:   target platform
```

The adapter renders native Prelude Rust library, binary, and test rules.
Prelude providers are reused directly where they carry the required compiled
and runnable contracts. Repository wrappers add explicit environment,
resources, quality validation, or build-script execution policy; they do not
duplicate compilation behavior.

A build script consists of a private executable target and a run action. The
run action receives Cargo-compatible package and target/exec environment,
declared source/config inputs, and explicit runtime tool providers. Its parsed
outputs are typed artifacts for cfg flags, environment variables, linker
arguments, search paths, and generated output files. Consumers depend on only
the outputs they use. Undeclared filesystem or tool access fails in the
isolated action.

Proc macros compile and run for the execution platform. Their downstream crate
may compile for a different target platform. Both configurations and toolchain
identities remain distinct in action keys and evidence.

The Rust toolchain provider supplies compatible rustc, rustdoc, clippy-driver,
rustfmt, target standard libraries, linker, compiler, archiver, and declared
build utilities. The sibling toolchain and platform subsystem owns how those
bytes are produced and transported.

## Quality Surfaces

```text
Rust semantic graph
  |-- compile
  |-- clippy -------> diagnostic artifacts -> policy validator
  |-- rustfmt check -----------------------> validation
  |-- tests --------> harness/case inventory + executions -> validation
  `-- rustdoc ------> docs + doc-test inventory/executions -> validation
```

Clippy compilation may produce diagnostics even when findings exist. The
authoritative Clippy target therefore includes a validator that parses the
declared diagnostic protocol and fails on every repository-denied finding.
The diagnostic artifact remains available independently for editors and
reporting.

Rustfmt runs in check mode against declared first-party Rust sources with the
configured edition and formatting policy. It writes no source input. Its
validation result is independently cacheable from compilation.

Unit tests compile the declared library test harness. Integration tests are
independent crate targets with explicit dependencies, binary resources,
runtime tools, fixtures, environment, and platform constraints. Documentation
tests compile and execute through rustdoc when applicable. Property and golden
tests remain integration or unit harness cases, but their seeds, fixtures, and
golden bytes are declared inputs.

Test evidence records harness target, executable identity, case inventory, case
outcomes, and resource identities. Admission compares it with an independent
reference inventory and uses deliberate compile, lint, format, unit,
integration, documentation, build-script, and resource mutations as RED
controls.

## Terminal Authority and Artifact Flow

```text
Cargo-compatible request metadata ----> Reindeer maintenance
                                                |
                                                v
first-party sources + generated third-party graph + toolchain
                                                |
                                                v
                              Buck compile and quality graph
                                                |
                                                v
                                normalize and package artifact
                                                |
                                                v
                                  verified convergence import
```

For an admitted package and platform, the Buck graph is terminal authority for
compilation and every quality surface described above. Cargo-compatible
metadata remains available to dependency maintenance, editors, and ecosystem
tools, but Cargo execution does not independently gate or publish the same
artifact. The convergence layer verifies and imports the Buck artifact and may
add system runtime dependencies or wrappers; it does not rebuild the Rust
sources.

This authority is admitted per package and platform. An unsupported platform
has no compatible configured target and fails closed. Passing on one platform
does not imply another target or execution platform is supported.

## Support-Tool Consumer Relationship

```text
stage0 or promoted BuckSupportToolInfo
                   |
                   +--> Rust quality and packaging support actions
                   `--> stage1 conformance actions
```

Rust rules consume the parent contract's support-tool provider for shared
mechanics such as deterministic packaging, validation, or report processing.
The provider's executable digest, protocol ABI, runtime closure, target
platform, and execution platform are declared action inputs.

Rust target execution does not build the stage0 realization through the same
Rust toolchain that stage0 is required to establish. Stage0 publication and
platform mechanics live in the sibling toolchain and platform subsystem. A
graph-built successor is promoted only through the parent's conformance
protocol, and Rust rules switch provider bindings without a runtime fallback.
