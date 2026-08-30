# 0017 Bounded Cargo Manifest Binding

Status: accepted

## Context

The horizontal authoring architecture needs a Rust binding, but Cargo workspace,
profile, feature, target-predicate, build-script, proc-macro, and Reindeer alias
semantics do not yet have retained parity evidence across the required matrix.
Deferring the entire binding would leave known Cargo authoring facts in the
target-execution authority.

## Evidence and Argument

Repository inspection and `cargo metadata --offline --locked --no-deps`
established that authored Cargo manifests already own package identity, target
inventory, features, and direct dependency requests. Cargo lock state and
Reindeer own selected third-party topology. File sets, fixtures, runtime policy,
and operation-specific use edges are not native Cargo facts and require a
repository semantic overlay.

This high-level boundary does not depend on the unsettled normalization details.
Ratifying it now prevents a parallel manifest model while fail-closed design
questions keep unproved semantics out of admitted contributions.

## Options

| Option                | Result   | Tradeoff                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------------------- |
| Bounded Draft binding | Selected | Establishes authority now; advanced forms remain explicitly unadmitted          |
| Defer the Rust leaf   | Rejected | Avoids provisional text but preserves a known authoring/execution category leak |

Generating Cargo manifests from a new Genie model and placing all Buck semantics
in Cargo `package.metadata` were ruled out before the decision because they
would introduce a parallel authority or pollute the ecosystem manifest.

## Decision

Create the Rust Cargo authoring binding now with Draft status. Authored Cargo
manifests own Cargo-native package, target, feature, and dependency-request
facts. A separate repository overlay owns only irreducible semantic operations
and relationships. Dependency selection remains with Cargo lock state and
Reindeer; actions and tools remain with Rust target execution.

Advanced Cargo and Reindeer semantics fail closed until their individual design
questions have retained parity and invalidation evidence.

## Consequences

- The VRS represents the stable Rust authority boundary without claiming full
  Cargo/Reindeer compatibility.
- The overlay cannot repeat manifest or resolver data.
- Each advanced semantic dimension can become admitted independently through a
  spec amendment and evidence, without moving the binding boundary.
- Unsupported manifest forms produce a structured unsupported-semantics result
  rather than a conservative guess.

## Amendment 1 — Whole-Workspace Selected Topology (2026-08-30)

The strict Phase-5 Reindeer baseline proved that changing the virtual
workspace's member set requires Cargo to rewrite `Cargo.lock`; the authoritative
workspace lock cannot serve a members-only projection byte-for-byte. A derived
scoped lock would add a second generated lock identity, schema, and freshness
contract before the first product could build.

Use the authoritative five-member `rust/Cargo.toml` and `rust/Cargo.lock`
directly to generate one strict Reindeer selected-third-party graph. Product
admission remains incremental: `otel-scrape` is the first first-party product,
but its graph may reuse the already-selected dependencies needed by the other
workspace members. Reindeer generation must fail on every unresolved build
script, remain network-free during Buck execution, and retain Cargo manifests
and the root lock as the only request and resolution authorities.

This chooses earlier selected-topology breadth over a parallel derived lock.
The generated graph is a projection, not a second dependency authority.
