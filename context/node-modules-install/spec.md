# pnpm Repo-Boundary Hoisted Spec

This document specifies the intended `pnpm` install and runtime model for
standalone repos and composed megarepos.

It builds on
[requirements.md](./requirements.md).

## Scope

This spec defines:

- standalone and composed workspace topology
- aggregate topology generation
- peer-sensitive package convergence
- install ownership
- local cross-repo resolution
- linker and runtime behavior
- package-closure lockfile refresh
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
- peer-sensitive package family:
  a package family whose runtime identity matters and therefore must not split
  across one composed runtime graph, for example React, Emotion, and similar
  context- or singleton-bearing packages

## Example

```text
standalone repo-a
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml

composed root
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  repos/repo-a -> ~/.megarepo/.../repo-a/refs/heads/main
```

The composed root may reuse the same task and builder implementation as
`repo-a`, but it does not reuse `repo-a`'s `pnpm-lock.yaml`.

Reason:

- `repo-a/pnpm-lock.yaml` describes the standalone topology
- `composed-root/pnpm-lock.yaml` describes the composed topology

If the composed root imports `repo-a`'s aggregate lockfile as authoritative,
pnpm is being asked to validate the wrong workspace shape.

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
- Each composed topology owns its own generated `package.json`,
  `pnpm-workspace.yaml`, and `pnpm-lock.yaml`.
- A composed topology must not treat an upstream repo's aggregate lockfile as
  authoritative unless the topology is actually identical.

## Aggregate Topology Generation

The aggregate root is generated from the composed topology and must include:

- the explicit workspace member list for the composed topology
- composition-local `link:` dependencies for cross-repo local packages
- the aggregate dependency closure for linked cross-repo packages
- a composition-local aggregate lockfile derived from the composed topology

Aggregate generation is topology-local:

- repos may share task and builder code
- each composed repo generates its own aggregate root files
- standalone repo lockfiles remain authoritative only for standalone topologies

The aggregate dependency closure must contain the external packages needed so
that linked packages resolve their direct and shared runtime dependencies from
the composed topology at runtime.

Version selection for the aggregate dependency closure must be deliberate and
validated. The implementation must not silently let the aggregate root drift
from what linked packages declare.

## Peer-Sensitive Package Convergence

- Peer-sensitive package families must converge at the aggregate root.
- Convergence may be implemented with generated aggregate dependencies,
  generated `pnpm.overrides`, or both.
- Convergence is not satisfied merely by pinning some version. The selected
  aggregate versions must be validated against the participating standalone
  repos.
- A convergence mechanism that forces one runtime instance of the wrong
  version does not conform to this spec.

At minimum, validation must prove:

- all participating repos accept the selected versions structurally
- the composed runtime resolves one live instance for each peer-sensitive
  package family under test
- the selected aggregate versions match the intended policy instead of
  silently overriding it

## Install Ownership

- Each standalone topology owns its own standalone install state.
- Each composed topology owns its own aggregate-root install state.
- Standalone and composed install states may coexist against the same
  physical source tree.
- A composed install must not mutate nested repo root lockfiles or nested repo
  root `node_modules`.
- A composed install must use that composed topology's own generated aggregate
  root files.

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
- Package-local `node_modules` inside workspace packages are acceptable only
  as derived projection state of the active topology. They must not be
  independently install-owned or allowed to diverge from the active topology.

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
- package-closure lockfile refresh
- composed runtime execution
- aggregate topology generation

Managed tooling must distinguish between:

- shared implementation logic reused across repos
- topology-local generated files owned by a specific standalone or composed
  repo

At minimum the managed wrappers must:

- select the correct topology root
- generate or validate the aggregate root inputs for the selected composed
  topology before install
- ensure nested standalone repos are ready before a composed install depends
  on them
- apply the required runtime symlink-preservation flags for composed
  execution
- validate that aggregate topology generation and dependency closure are in
  sync before install and runtime execution

Package-level install commands in the live worktree are not supported if they
materialize package-local `node_modules`. Package-level closure refreshes in
the live worktree must be lockfile-only.

## Package-Closure Lockfile Refresh

- Standalone repo roots own their normal install state and lockfiles.
- Package-level `pnpm-workspace.yaml` files may remain as package-closure
  metadata for builders and lockfile generation.
- In the live worktree, package-level refreshes must use lockfile-only
  commands and must not create or mutate package-local install ownership.
- A package-level command that materializes fresh package-local install state
  outside the active topology owner violates this spec.

## Lockfiles and Publishing

- Standalone repos keep their own standalone lockfiles.
- A composed topology keeps its own aggregate lockfile.
- Both lockfile kinds must stay checkout-portable and topology-specific.
- Publishable standalone manifests must remain free of composition-local link
  metadata.
- Reusing a standalone repo's aggregate lockfile inside another composed repo
  is non-conforming unless the composed topology is identical.

## Validation and CI

CI must validate standalone and composed topologies separately.

Composed validation must cover:

- aggregate root inputs are generated locally for the composed repo
- aggregate topology generation
- aggregate dependency closure generation
- peer-sensitive package convergence
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
