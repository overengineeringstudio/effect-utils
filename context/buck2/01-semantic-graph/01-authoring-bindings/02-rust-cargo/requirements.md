# Rust Cargo Authoring Binding Requirements

**Role:** This bounded draft binding composes authored Cargo manifest facts
with repository-only operation intent into a Rust contribution to the parent
[authoring-binding contract](../requirements.md). It does not define Cargo
resolution, Reindeer generation, Prelude rules, or Rust action execution.

## Context

Authored `Cargo.toml` is the current package and dependency-request authority.
`Cargo.lock` and Reindeer own selected third-party topology. Cargo has no
native representation for every repository semantic operation, so a narrow
overlay may reference Cargo declarations without copying them.

## Assumptions

- **BUCK.GRAPH.BIND.RUST-A01 Cargo request authority:** Authored Cargo manifests
  own package, declared target, feature, and direct dependency-request facts.
- **BUCK.GRAPH.BIND.RUST-A02 Resolver authority:** Cargo lock state, Reindeer
  configuration and fixups, and vendored-source integrity own selected
  third-party topology and stable Buck aliases.
- **BUCK.GRAPH.BIND.RUST-A03 Shared binding:** The contribution satisfies
  `BUCK.GRAPH.BIND-R01` through `BUCK.GRAPH.BIND-R09`.

## Acceptable Tradeoffs

- **BUCK.GRAPH.BIND.RUST-T01 Bounded draft:** The initial binding may admit
  only manifest semantics proved against Cargo's own observations and reject
  all unresolved advanced forms.
- **BUCK.GRAPH.BIND.RUST-T02 Explicit operation overlay:** Repository-specific
  operation identity and dependency-use intent may live beside `Cargo.toml`
  because Cargo manifests do not express that Buck semantic relation.

## Requirements

### Must preserve Cargo authority

- **BUCK.GRAPH.BIND.RUST-R01 No parallel manifest:** The binding and operation
  overlay must not reauthor package metadata, Cargo targets, dependency
  requests, features, target predicates, or workspace inheritance already
  expressed by authoritative Cargo manifests.
- **BUCK.GRAPH.BIND.RUST-R02 Canonical Cargo references:** Overlay values must
  identify Cargo packages, targets, and direct dependency declarations by
  stable canonical references whose aliases, dependency kinds, target
  predicates, and workspace-inheritance provenance are validated against the
  authoritative manifest set.
- **BUCK.GRAPH.BIND.RUST-R03 Resolver separation:** The contribution must not
  contain selected versions, checksums, feature-union results, transitive
  edges, source paths, Reindeer fixups, or generated third-party rule details.

### Must keep the overlay irreducible

- **BUCK.GRAPH.BIND.RUST-R04 Operation-only overlay:** The overlay may add
  semantic operation identity, operation-to-Cargo-target joins, additive exact
  direct dependency uses where admitted, file-set roles, validation
  relationships, and symbolic capability requests only. It must not repeat
  Cargo-derived baseline dependencies.
- **BUCK.GRAPH.BIND.RUST-R05 No generated Cargo authority:** The binding must
  consume the existing Cargo request chain. It must not require a separate
  Genie model that generates `Cargo.toml` or a second handwritten resolver-root
  dependency map.
- **BUCK.GRAPH.BIND.RUST-R06 Fail on unproved semantics:** Workspace
  inheritance, target auto-discovery, target predicates, optional dependencies
  and features, required features, build dependencies, build scripts, and proc
  macros must fail closed wherever their contribution or resolver-join meaning
  falls outside the admitted model. Cargo execution profiles must not silently
  enter dependency-root identity.

### Must earn Cargo compatibility

- **BUCK.GRAPH.BIND.RUST-R07 Cargo parity oracle:** Admission must compare
  the workspace-root and member manifest set plus Cargo's convention-based
  target-discovery inputs with Cargo's supported metadata observations for an
  explicit corpus, without treating pathful or resolved Cargo output as the
  normalized semantic authority.
- **BUCK.GRAPH.BIND.RUST-R08 Root-policy evidence:** Exact operation roots and
  any conservative Cargo-scope policy must be admitted separately by target
  kind, dependency scope, feature configuration, and target predicate. Normal
  baseline roots and operation-specific additive roots must remain
  distinguishable.
- **BUCK.GRAPH.BIND.RUST-R09 Resolver-join evidence:** The mapping from
  canonical direct declarations to Reindeer aliases must preserve normal,
  development, build, target, host, build-script, and proc-macro distinctions or
  reject the unsupported case before first-party projection.
