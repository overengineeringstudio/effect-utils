# Rust Cargo Authoring Binding Specification

This document specifies the bounded Rust Cargo authoring binding. It builds on
[requirements.md](./requirements.md) and the shared
[authoring-binding specification](../spec.md).

## Status

Draft. The authority, normalization, and default-feature boundaries are
selected. Resolution-domain scope, supported `cfg` breadth, and Cargo-profile
equivalence remain open; build-script and cross-platform proc-macro execution
remain unadmitted.

## Scope

This spec defines the current Cargo-manifest authority, the permitted
repository operation overlay, their join, and the evidence required to admit
additional manifest semantics. Cargo resolution and Reindeer output belong to
dependency maintenance; Prelude rule construction and Rust tools belong to
target execution.

## Requirement Trace

| Section                 | Requirements                                                                 |
| ----------------------- | ---------------------------------------------------------------------------- |
| Authority boundary      | BUCK.GRAPH.BIND.RUST-R01, BUCK.GRAPH.BIND.RUST-R02, BUCK.GRAPH.BIND.RUST-R03 |
| Repository overlay      | BUCK.GRAPH.BIND.RUST-R04, BUCK.GRAPH.BIND.RUST-R05, BUCK.GRAPH.BIND.RUST-R06 |
| Compatibility admission | BUCK.GRAPH.BIND.RUST-R07, BUCK.GRAPH.BIND.RUST-R08, BUCK.GRAPH.BIND.RUST-R09 |
| Workspace composition   | BUCK.GRAPH.BIND.RUST-R10, BUCK.GRAPH.BIND.RUST-R11                         |

## Authority Boundary

```text
authored Cargo.toml ------------------+
                                      +--> Rust Cargo binding --> contribution
repository operation overlay --------+
                                                |
Cargo.lock + Reindeer config/fixups ------------+--> resolver join validation
                                                `--> not semantic input
```

`Cargo.toml` owns package identity, Cargo target declarations, direct
dependency aliases and requests, dependency kind, features,
default-feature policy, target predicates, and Cargo-native feature relations.
An ancestor workspace manifest owns inherited facts where Cargo says it does.
Native `[workspace.dependencies]` entries are reusable request templates, not
evidence that every member uses the dependency. Member manifests own the use
site, dependency kind, target predicate, optionality, and additive features.
Package-local declarations remain permitted as explicit exceptions when Cargo
inheritance cannot express a genuinely different request policy.

`Cargo.lock`, Reindeer configuration and fixups, and vendored sources own
selected third-party identity. They validate that a normalized external root
can reach a stable selected alias, but their selected values do not enter the
first-party contribution.

The binding uses a pure, strict observation of the workspace-root and member
manifests plus the convention-discovery file set that can create Cargo targets.
It normalizes inherited values while retaining their root/member provenance.
Cargo metadata may serve as an admission and freshness oracle. Full resolved
metadata is not the normalized authority because it executes a process, reports
physical paths, and includes selected feature unions.

Workspace-root Cargo profiles are execution policy. They do not enter package,
target, dependency-root, or contribution identity. Target execution owns any
equivalence between Cargo profiles and Buck profiles.

One `Cargo.lock` belongs to each deliberately selected Cargo resolution domain.
It owns selected topology for that domain, but its whole bytes do not enter
every Buck action key. The resolver join derives a normalized reachable
closure for the operation, platform, dependency kind, and effective features;
that closure is the invalidation boundary.

A narrow Rust validator may require catalog-eligible member dependencies to use
`workspace = true`, reject ignored or bypassing request keys, admit explicit
exceptions, and compare normalized declarations with `cargo metadata
--no-deps`. It validates native Cargo authoring and does not generate manifests.

## Normalized Cargo Contribution

```text
CargoDependencyDeclaration {
  alias: CargoDependencyAlias
  kind: "normal" | "dev" | "build"
  request: AuthoredCargoRequest
  optional: boolean
  defaultFeatures: AuthoredDefaultFeaturePolicy
  features: AuthoredDependencyFeature[]
  targetPredicate?: AuthoredCfgExpression
  provenance: RootOrMemberManifestRef
}

CargoFeatureExpression =
  | { kind: "feature", name: CargoFeatureName }
  | { kind: "dependency", alias: CargoDependencyAlias }
  | { kind: "forward", alias: CargoDependencyAlias, feature: string }
  | { kind: "conditional-forward", alias: CargoDependencyAlias, feature: string }
```

The contribution preserves strong `dependency/feature` and conditional
`dependency?/feature` forwarding as distinct expressions. A target's
`required-features` gates whether that target exists for an operation; it does
not activate those features. Normal and development predicates are evaluated
against the target platform. Build-dependency predicates are evaluated against
the execution host. Unsupported `cfg` syntax fails closed.

## Repository Operation Overlay

The following logical schema is an illustrative upper bound for experiments,
not an admitted V1 representation:

```text
RustOperationOverlayV1 {
  schemaVersion: 1
  package: LogicalPackageId
  operations: RustOperationIntent[]
}

RustOperationIntent {
  id: LogicalTargetId
  cargoTarget: CargoTargetRef
  kind: RustOperationKind
  dependencyUses: CargoDependencyUsePolicy
  fileSets: FileSetIntent[]
  validations: LogicalTargetId[]
  capabilities: CapabilityRequirement[]
}

CargoDependencyUse {
  alias: CargoDependencyAlias
  kind: "normal" | "dev" | "build"
}

CargoDependencyUsePolicy =
  | { kind: "additive-exact", uses: CargoDependencyUse[] }
  | { kind: "cargo-dev-scope" }
```

Its fields show the maximum currently hypothesized join, not settled presence,
cardinality, or selector encoding. It is not a settled filename or serialization
format. The overlay cannot contain crate versions, dependency requests, feature lists,
target predicates, Cargo target paths, selected aliases, or resolver data. It
refers to those facts by `CargoTargetRef` or `CargoDependencyUse` and the
binding validates them against the manifest authority.

Each Cargo target derives its normal and platform-conditioned baseline roots
from the normalized Cargo contribution. The overlay adds only roots specific to
the repository operation, principally development dependencies for individual
integration-test targets. It never repeats the normal baseline. The
`cargo-dev-scope` alternative is an explicit, separately admitted migration
policy rather than a fallback for missing exact uses.

The overlay is a package-local typed module consumed by the existing
`BUCK.genie.ts` lifecycle. It may import Cargo TOML through the supported Bun
loader, but it does not introduce another parser dependency, central Rust
package registry, or generator lifecycle. Admission must prove that
`Cargo.toml` and convention-discovered target changes make stale BUCK output
observable in both run and watch workflows.

The binding admits only explicitly proven operations and manifest forms.
Encountering an unsupported predicate, feature interaction, build script, or
proc-macro context returns a structured unsupported-semantics error rather than
a conservative guess.

No separate Genie package model generates `Cargo.toml`. If Reindeer requires a
synthetic resolver root, that artifact is a dependency-maintenance projection
from Cargo authority and is not part of this overlay.

## Compatibility Admission

```text
authored TOML --pure observation--+
                                   +--> normalized comparison --> verdict
cargo metadata --oracle-----------+

canonical direct request --> Reindeer alias lookup --> scope/platform verdict
```

The manifest corpus adds one semantic dimension at a time and compares alias,
request, dependency kind, target predicate, default-feature policy, feature
list, target identity, and inheritance provenance with Cargo's observation.
Each admitted case includes a mismatch RED control and an equivalent GREEN
case.

Root-policy experiments measure exact operation uses against Cargo-visible
scope. A conservative `cargo-dev-scope` policy is available only after its
invalidation fanout is measured and explicitly admitted for a target kind; it
is not the default consequence of a missing exact-use model.

Resolver-join experiments prove that Reindeer aliases retain the distinctions
needed by first-party roots across normal, development, build, target-specific,
proc-macro, and build-script cases. A missing distinction fails admission
rather than being reconstructed from generated BUCK syntax.

The authored dependency handle carries only alias, dependency kind, and target
predicate. Selected target identity and whether it is a proc macro belong to
Cargo lock/metadata and Reindeer. Stable Buck labels belong to Reindeer public
aliases. Prelude owns host/target, `exec_dep`, and `plugin_dep` transitions.

Reindeer admission sets unresolved-fixup handling to strict, classifies every
configured platform as execution or target, pins Reindeer with the Prelude
version, and reviews every reachable build script as `run = true` or
`run = false`. Linux and Darwin provider-cardinality controls are required
before build-script or cross-platform proc-macro support is admitted.

## Open Design Questions

- **BUCK.GRAPH.BIND.RUST-DQ1 Default-feature selection:** Does each operation
  inherit Cargo's default features unless it opts out, or must the overlay name
  the complete feature activation set? **Resolved:** inherit Cargo defaults
  unless the authoritative request disables or replaces them, and normalize
  the effective selection into operation identity. See decision 0002.
- **BUCK.GRAPH.BIND.RUST-DQ2 Supported `cfg` breadth:** Which initial Cargo
  predicate grammar is worth supporting beyond the current repository corpus?
  Resolve with Linux and Darwin fixtures for the proposed subset; all other
  syntax continues to fail closed.
- **BUCK.GRAPH.BIND.RUST-DQ3 Execution-profile policy:** Does Rust target
  execution expose only canonical Buck profiles or promise equivalence with
  arbitrary Cargo profiles? This is owned by
  [Rust target execution](../../../03-target-execution/02-rust/spec.md) and
  must not change dependency-root identity.
- **BUCK.GRAPH.BIND.RUST-DQ4 Resolution-domain scope:** Do `otelite` and
  `otel-scrape` intentionally share one compatibility/update domain and root
  lockfile, conditional on a Nix bridge that preserves package-local closure
  identity, or do they remain separate Cargo resolution domains while sharing
  only validation and authoring policy?
