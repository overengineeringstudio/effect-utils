# pnpm Repo-Boundary Hoisted Spec

This document specifies the intended `pnpm` install and runtime model for
standalone repos and composed megarepos.

It builds on
[requirements.md](./requirements.md).

## Scope

This spec defines:

- standalone and composed workspace topology
- aggregate topology generation
- install ownership
- local cross-repo resolution
- linker and runtime behavior
- lockfile and publish behavior
- CI and validation expectations

## Terminology

- standalone topology:
  one repo root, that repo's workspace members, and that repo's canonical
  manifests and lockfile
- composed topology:
  one aggregate root, its workspace members, and its canonical manifests and
  lockfile
- aggregate root:
  the generated root package for a composed topology
- composition-local link:
  private composed-topology metadata that resolves a package name to a local
  source path across a repo boundary
- aggregate dependency closure:
  the external dependency set that must be installed at the aggregate root so
  that linked cross-repo packages resolve coherently at runtime

## Topology Model

### Standalone topology

- Each repo remains a normal standalone `pnpm` workspace.
- `workspace:` remains the protocol inside a standalone repo.
- Standalone manifests and lockfiles remain the publishable source of truth.

### Composed topology

- Each composed megarepo has a generated aggregate root.
- The aggregate root lists workspace members explicitly.
- Cross-repo links are expressed only in generated composed-topology state.
- `workspace:` is not used across repo boundaries.

## Aggregate Topology Generation

The aggregate root is generated from the composed topology and must include:

- the explicit workspace member list for the composed topology
- composition-local `link:` dependencies for cross-repo local packages
- the aggregate dependency closure for linked cross-repo packages

The aggregate dependency closure must contain the external packages needed so
that linked packages resolve their direct and shared runtime dependencies from
the composed topology at runtime.

Version selection for the aggregate dependency closure must be deliberate and
validated. The implementation must not silently let the aggregate root drift
from what linked packages declare.

## Install Ownership

- Each standalone topology owns its own standalone install state.
- Each composed topology owns its own aggregate-root install state.
- Standalone and composed install states may coexist against the same
  physical source tree.
- A composed install must not mutate nested repo root lockfiles or nested repo
  root `node_modules`.

## Local Cross-Repo Resolution

- Cross-repo local dependencies resolve to the real source files exposed
  through `repos/*`.
- Local source edits must become visible to dependents without another
  install step.
- If a dependency is intended to resolve locally but does not, the mismatch
  must be surfaced explicitly.

## Linker Model

- The supported linker is `node-linker=hoisted`.
- The hoisted linker applies to standalone and composed topologies.
- Package-local `node_modules` inside workspace packages are not part of the
  supported steady state.

This linker choice is required because:

- it prevents package-local install state from leaking back into linked
  packages in the way the isolated linker does
- it allows standalone and composed topologies to coexist in the same source
  tree when combined with the runtime model below

## Runtime Model

### Composed runtime

Composed runtime entrypoints must preserve logical symlink paths.

For Node this means:

- `--preserve-symlinks`
- `--preserve-symlinks-main`

For Bun this means the equivalent preserve-symlink flags.

Under these flags, linked packages resolve their shared runtime dependencies
through the composed topology instead of collapsing back to standalone real
paths.

### Standalone runtime

Standalone runtime entrypoints run against the standalone topology and remain
coherent under the same hoisted linker model.

## Managed Tooling

Managed tooling must provide topology-aware entrypoints for:

- standalone install
- composed install
- composed runtime execution

At minimum the managed wrappers must:

- select the correct topology root
- apply the required runtime symlink-preservation flags for composed
  execution
- validate that aggregate topology generation and dependency closure are in
  sync before install and runtime execution

## Lockfiles and Publishing

- Standalone repos keep their own standalone lockfiles.
- A composed topology keeps its own aggregate lockfile.
- Both lockfile kinds must stay checkout-portable and topology-specific.
- Publishable standalone manifests must remain free of composition-local link
  metadata.

## Validation and CI

CI must validate standalone and composed topologies separately.

Composed validation must cover:

- aggregate topology generation
- aggregate dependency closure generation
- standalone-first then composed install
- composed-first then standalone install
- standalone runtime coherence
- composed runtime coherence
- duplicate-instance detection for shared runtime dependencies
- live cross-repo edit propagation

The validation matrix must include at least one realistic multi-repo smoke
test with actual `repos/*` symlinked paths.

## Conformance

An implementation conforms to this spec only if it preserves the invariants
above while satisfying
[requirements.md](./requirements.md)
for the supported package set.
