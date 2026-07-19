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
**Projection State**, **Store Cache**, and **Repair**.

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

**Store Cache** is a disposable, package-manager-owned cache used while
materializing dependencies. It may contain immutable content-addressed package
files and mutable package-manager-derived lookup indexes. Neither facet is
authoritative Dependency Graph or Projection State. A Store Cache may be
shared by mutually trusted Materialization Roots without sharing their graphs.

**Content-addressed Package Data** is the immutable byte layer whose identity is
derived from content. It may be reused across every compatible Materialization
Root. It is part of a Store Cache but does not include that cache's mutable
derived indexes. _Avoid_: CAS when referring to the whole pnpm Store Cache.

**Reuse Scope** is the set of compatible consumers allowed to reuse equivalent
immutable data or deterministic work. It is an independent facet from Authority
Scope: widening reuse does not grant mutation or repair authority.

**Authority Scope** is the smallest boundary within which one owner may mutate,
repair, or discard state without coordinating independent consumers. A live
Dependency Graph has Materialization-Root Authority Scope even when its package
data has host-user Reuse Scope.

**Global Virtual Store** is pnpm's cross-project virtual-store realization. It
shares graph/topology realization state and is therefore distinct from sharing
a Store Cache or Content-addressed Package Data. _Avoid_: GVS as a synonym for
cache reuse or dependency identity.

**Hermetic Dependency Artifact** is an immutable dependency-data and topology
result keyed by the complete declared graph, platform, package-manager policy,
and every other identity-affecting input. Construction is lifecycle-free and
atomic; consumers cannot mutate it. It may have broad Reuse Scope without
granting graph or repair authority, analogous to a Nix derivation result or a
build-system action result. A mutable pnpm Global Virtual Store is not such an
artifact.

**Store Cache Lease** coordinates package-manager mutation with cache-owner
maintenance. Its shared **admission** mode permits concurrent materialization;
its exclusive **maintenance** mode excludes materialization while the Store
Cache is pruned. _Avoid_: install lock, global install lock.

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

| Subject                        | Relation    | Object                               |
| ------------------------------ | ----------- | ------------------------------------ |
| Package Instance               | `partOf`    | Dependency Graph                     |
| Dependency Edge                | `partOf`    | Dependency Graph                     |
| Materialization Profile        | `describes` | equivalent immutable dependency work |
| Dependency Graph               | `partOf`    | Materialization Root                 |
| Dependency Graph               | `dependsOn` | Authoritative Materializer           |
| Projection State               | `dependsOn` | Dependency Graph                     |
| Materialization Root           | `dependsOn` | Store Cache                          |
| Repair                         | `dependsOn` | Authoritative Materializer           |
| Content-addressed Package Data | `partOf`    | Store Cache                          |

Store placement is a facet of a realization: local development may use a
host-scoped cache, CI may use a job-scoped cache, and Nix prepared dependencies
may use an independent builder cache. Placement does not change Materialization
Profile or Package Instance identity.

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
- Use **Store Cache** for the whole pnpm store. Do not use **shared store** to
  imply shared Dependency Graph state, and do not use **content pool** for a
  store that also contains pnpm-owned derived indexes.
- Use **CAS** only for a system with an explicit content-address/ownership/GC
  contract. For pnpm, say **Content-addressed Package Data** for the byte layer
  and **Store Cache** for the whole package-manager-owned cache.
- State **Reuse Scope** and **Authority Scope** independently; a broader reuse
  scope is not evidence for broader graph, mutation, or repair authority.
- Use pnpm **package snapshot** only for the pnpm representation and **Package
  Instance** for the cross-realization concept.
