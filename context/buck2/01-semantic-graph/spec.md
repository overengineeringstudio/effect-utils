# Semantic Graph Spec

This document specifies the composed model, language bindings, and Buck
projection. It builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** graph shape, normalization, binding contracts, projection, and
freshness mechanics.

**Does not define:** dependency resolution algorithms, action command lines, or
materialization (03).

## Composition

```text
ecosystem metadata (manifests, lockfiles) ---+
genie-composed typed models -----------------+--> normalized graph
repository policy ---------------------------+        |
                                                      v
                                     projection: BUCK files + closure
                                     descriptors
```

## Graph Shape

```text
RepositoryGraph {
  schemaVersion
  packages: Package[]
  operations: Operation[]
  dependencyHandles: DependencyHandle[]
}

Package { id, root, firstPartyDeps, sourceRoles }
Operation { id, packageId, kind, sources, dependencyHandle, capabilities,
            outputs }
DependencyHandle { id, resolver, selectedIdentity, closureRef }
```

Concrete encodings are versioned; unknown schema versions fail. Paths are
repository relative, normalized, and never escape their declared package root.
Normalization validates unique stable IDs, edge targets, source ownership,
operation output roles, and handle existence; non-semantic collection order is
sorted before encoding.

## Language Bindings

A binding lowers ecosystem facts into the shared graph at a typed boundary. It
does not select dependency versions, render Buck syntax, bind tools, or
execute targets.

- **TypeScript:** the genie composition exposes exact dependency declarations
  through typed facets and field-qualified handles; handle generics are erased
  at the boundary (measured necessity: leaking them produced a 37.9 MB
  declaration and 1.54 GB memory; alias collisions occurred in 9 of 36
  manifests — [decision 0005](../.decisions/0005-operation-dependency-roots.md)).
- **Rust:** authored `Cargo.toml` is the request authority; Cargo metadata
  preserves request facts. Binding mechanics follow the rust-cargo decisions
  ([0017](../.decisions/0017-bounded-cargo-manifest-binding.md),
  [0018](../.decisions/0018-cargo-default-feature-semantics.md),
  [0019](../.decisions/0019-one-effect-utils-resolution-domain.md)).

## Projection

Each package receives a package-local generated shard (BUCK file) derived from
its normalized model and the stable shared rule facade only; shards inline no
action commands or toolchain paths. Provenance headers identify the authored
source, schema version, and regeneration command; a generator implementation
change that preserves semantics must not churn shard bytes. Freshness
verification regenerates into memory or temporary storage, compares exact
bytes, and reports the owning semantic source on mismatch. Generated files are
read-only as a local guardrail; Git write bits are not freshness identity.

### Cargo foreign-package instantiation

```text
foreign Cargo manifest + provider source exports
                         |
                         v
consumer member shard: foreign-<package-name>-lib
                         |
                         v
consumer third-party graph <--- consumer Cargo.lock / resolved edges
```

`<workspace>/foreign-packages.json` declares repository-relative manifests of
path dependencies outside the consumer workspace. The lexicographically first
consumer member shard owns one library instance per declared foreign package.
All consumer members and foreign path edges refer to that instance. Provider
shards retain their own libraries and export package files as
`cargo-source/<package-relative-file>`; consumer instances consume those same
files through mapped sources without copying source code.

Foreign manifests inherit metadata and dependency requests from their owning
Cargo workspace, but library features unify through the consumer's path edges
and registry dependencies resolve in the consumer's Reindeer universe. Thus a
third-party type crossing a foreign public API has the same crate identity as
the consumer's corresponding resolved dependency.

The supply manifest preserves the consumer Cargo resolution and selected
features. Canonical dependency aliases follow resolved manifest edges, not
package-ID sorting. `<third-party>/cargo-resolution.json` records each local
manifest's dependency key, kind, optional target condition, resolved package
version, and supply alias. The projector uses those exact edges, including
synthetic aliases for simultaneous versions, and fingerprints the sidecar.
Alias selection does not override individual Buck edges.

This is per-consumer instantiation (decision q20); a repository-wide Cargo
universe is a separate composition policy ([dotfiles#4220](https://github.com/schickling/dotfiles/issues/4220)).

## Conformance

A binding or projector change must prove: equal input produces equal bytes;
reordered non-semantic input produces equal bytes; one local mutation changes
only its owning shard and dependent operations; missing, duplicated, or
overlapping ownership fails; resolver-selected identities survive round-trip
unchanged.
