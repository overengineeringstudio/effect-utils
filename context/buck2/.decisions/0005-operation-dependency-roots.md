# 0005 Operation Dependency Roots

Status: accepted for TypeScript; Rust binding deferred

## Context

Each build operation needs the direct dependency requests it can observe, but
package manifests and ecosystem resolvers already own dependency declarations
and selected topology. Role-wide selection over-invalidates operations, while
separate resolver manifests duplicate request authority.

The existing TypeScript Genie composition can expose exact declarations, but
its emitted dependency maps erase provenance and sometimes widen keys to
`string`. Genie may also evaluate imported generator modules more than once.

## Decision

Semantic operations reference canonical package dependency declarations. For
TypeScript, `catalog.compose` produces immutable, field-qualified, branded
handles in the existing non-emitted `GenieOutput.meta` channel before emitted
maps widen. `package.json.genie.ts` remains the dependency SSOT and default
manifest projection. `BUCK.genie.ts` owns operations and imports only that
narrow facet.

Handles use stable value identity and contain package scope, manifest field,
alias, external/workspace provenance, and logical first-party identity. They do
not contain selected versions, resolver contexts, paths, or private topology.
Operation normalization resolves each structural value against the owning
package's canonical declarations, sorts and deduplicates roots, and erases
generic types into stable semantic IR. Only dependency fields with defined
resolver-root semantics produce handles; peer dependencies do not. The brand
is compile-time authoring safety, not runtime identity or a security boundary.

## Consequences

- Dependency requests, versions, workspace identity, and resolver data remain
  authored once.
- An operation repeats only the irreducible edge to a dependency declaration.
- Field qualification prevents collisions between dependencies and
  devDependencies.
- Pure value semantics and one-way imports make repeated Genie evaluation
  observationally equivalent and avoid projection cycles.
- Named shared root sets may be syntax sugar only if expanded before semantic
  identity. Output-data extraction remains migration-only.
- Rust retains authored Cargo manifests as request authority pending separate
  Cargo/Reindeer experiments; this decision does not impose a universal schema.
