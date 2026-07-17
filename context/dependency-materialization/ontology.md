# Dependency Materialization Ontology

This ontology owns the vocabulary shared by the dependency-materialization
subsystems. Subsystem documents inherit these terms and add only
realization-specific language.

## Federation

### Inherited language

- From package managers: **package**, **dependency**, **peer dependency**,
  **manifest**, **lockfile**, and **workspace**.
- From pnpm: **package snapshot** and **virtual store**. A pnpm package snapshot
  is a pnpm representation; it is not the cross-realization identity defined
  below.
- From Nix: **derivation**, **fixed-output derivation**, and **Nix store**.
- From graph theory: **graph**, **node**, and **edge**.

### Owned language

This context owns **Dependency Materialization**, **Materialization Root**,
**Materialization Profile**, **Authoritative Materializer**, **Dependency
Graph**, **Package Instance**, **Dependency Edge**, **Dependency Data**,
**Projection State**, **Shared Content Pool**, and **Repair**.

### Subsystem language

Live pnpm owns concrete workspace and virtual-store realization terms. Nix
prepared dependencies own prepared artifacts, native integrations, and hash
evidence. Buck2 owns its target and evidence representations. Those terms must
refer back to this ontology rather than redefine its identities or authorities.

## Language

### Materialization

**Dependency Materialization** is the process that realizes declared dependency
inputs as a dependency graph and its derived outputs.

**Materialization Root** is a concrete filesystem or build lifecycle boundary.
It realizes one active materialization profile at a time and owns any writable
realization state for that boundary.

**Authoritative Materializer** is the role held by the sole mechanism allowed to
select or change the Package Instance targeted by a Dependency Edge. A faithful
restore may reproduce an already-selected edge, and repair may discard a whole
owned realization before reinvoking the materializer; neither may select a
replacement target. pnpm holds this role for a live pnpm root.

**Materialization Profile** is a versioned, physical-root-location-independent
descriptor for equivalent immutable dependency work. It names normalized
topology and dependency inputs plus package-manager and toolchain policy. It
does not own mutable realization state, storage placement, repair, or garbage
collection. Prepared dependency and Buck2 evidence use its `profileKey` as a
compatibility boundary; a live root need not emit a separate profile artifact.

### Dependency graph

**Dependency Graph** is the package-instance nodes and dependency edges selected
by an authoritative materializer for one materialization root.

**Package Instance** is one semantically distinct resolved node in a dependency
graph. Its opaque identity is selected by the authoritative materializer and
distinguishes every resolution-relevant discriminator, including version, peer
context, patch, injection, and platform. A pnpm package snapshot is one
concrete representation of this concept.

**Dependency Edge** is a directed relation from a consuming package instance or
the materialization root to a dependency package instance. Its target identity
is authoritative graph data, not projection state.

### Derived outputs

**Dependency Data** is package content and graph data deterministically selected
from declared inputs under a materialization policy. It excludes mutable
package-manager state, projection state, and unclassified native or build
outputs.

**Projection State** is reproducible, non-authoritative state derived from a
dependency graph, such as executable shims and local tool metadata. Projection
may observe dependency edges but may not write them.

### Storage and lifecycle

**Shared Content Pool** is immutable content-addressed Dependency Data
referenced by more than one Materialization Root. It contains no writable
Dependency Graph or Projection State.

**Repair** is the restoration of a materialization root from declared inputs.
Repair may discard owned derived state and reinvoke the authoritative
materializer; it may not synthesize replacement dependency edges.

## Structure

The materialization pipeline is:

```text
declared dependency inputs + Materialization Root
  -> Authoritative Materializer
  -> Dependency Graph
     -> Dependency Data
     -> Projection State
     -> realization-specific native integration
     -> materialization evidence
```

The weight-bearing relations are:

| Subject                 | Relation    | Object                               |
| ----------------------- | ----------- | ------------------------------------ |
| Package Instance        | `partOf`    | Dependency Graph                     |
| Dependency Edge         | `partOf`    | Dependency Graph                     |
| Materialization Profile | `describes` | equivalent immutable dependency work |
| Dependency Graph        | `partOf`    | Materialization Root                 |
| Dependency Graph        | `dependsOn` | Authoritative Materializer           |
| Projection State        | `dependsOn` | Dependency Graph                     |
| Materialization Root    | `dependsOn` | Shared Content Pool                  |
| Repair                  | `dependsOn` | Authoritative Materializer           |

The Shared Content Pool relation exists only for realizations that share
content.

## Flagged ambiguities

- Use **Materialization Profile**, not bare **profile**, outside an immediately
  established materialization-profile context.
- Use **Materialization Root** for the owner of mutable realization state; do
  not call that state profile-owned.
- Qualify **identity** as **Materialization Profile identity** or **Package
  Instance identity**.
- Qualify **authority** by the operation it governs. Materialization, repair,
  and garbage collection are separate authorities unless explicitly proven to
  coincide.
- Use pnpm **package snapshot** only for the pnpm representation and **Package
  Instance** for the cross-realization concept.
