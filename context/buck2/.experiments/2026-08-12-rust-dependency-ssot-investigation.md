# Rust Dependency SSOT Investigation

Status: exploratory; no Rust design decision

## Current Authority

Rust does not currently have the same Genie ownership shape as TypeScript.
Authored `Cargo.toml` owns dependency requests, `Cargo.lock` owns resolver
selection, and Reindeer is the intended selected third-party Buck graph
boundary. Nix and Genie duplicate crate metadata in places but do not currently
reauthor the dependency request maps.

`cargo metadata --offline --locked --no-deps` preserved dependency aliases,
requests, normal/dev/build kinds, target predicates, default-feature policy,
features, and target declarations. Full metadata resolved 224 nodes for one
investigated CLI and 33 for another, with 24 shared nodes. Cargo's integration
test scope remained coarse: every integration test sees package dev
dependencies even when only one test uses a dependency.

## Candidate Boundary

```text
authored Cargo.toml
        |
Cargo manifest adapter
        |
typed dependency declarations
        |
operation-local use edges
        |
normalized semantic IR -> first-party BUCK

Cargo.lock + Reindeer config + fixups
        |
selected third-party graph and stable aliases
```

This is a hypothesis, not a cross-language abstraction commitment. Cargo
metadata is suitable as a parity oracle or normalization input, not as a pure
package composition function: it executes a process, observes paths, and full
resolution reports the selected feature union.

## Required Experiments

- Decode authored TOML and compare it with Cargo metadata across workspace
  inheritance, renames, optional dependencies, features, default features,
  target predicates, and required features.
- Measure Reindeer alias cardinality and preservation of platform-conditioned,
  build-dependency, and proc-macro host/target distinctions.
- Measure which targets benefit enough from finer-than-Cargo-scope precision to
  justify additional explicit use edges.
- Verify lock and generated graph invalidation locality without copying selected
  topology into first-party semantic data.

Until these pass, the Rust invariant is only one dependency-request authority
and no parallel handwritten dependency maps. Generating `Cargo.toml` from a
separate Genie model is not assumed.
