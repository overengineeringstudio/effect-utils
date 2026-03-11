# pnpm Single-Instance Repo-Boundary Spec

This document specifies the intended `pnpm` install and runtime model for
standalone repos and composed megarepos.

It builds on
[requirements.md](./requirements.md).

Its purpose is to ensure that equivalent standalone and composed views of the
same physical source tree resolve each dependency to one physical package
instance.

## Scope

This spec defines:

- the core invariants of the supported pnpm live-worktree model
- standalone and composed workspace topology
- aggregate topology generation
- install ownership
- local cross-repo resolution
- linker and runtime behavior
- package-closure lockfile refresh
- lockfile and publish behavior
- managed tooling and validation expectations

## Core Invariants

- Identity convergence:
  equivalent standalone and composed dependency graphs for the same physical
  source tree must converge to one physical instance of each dependency.
- JavaScript runtime identity:
  singleton-, symbol-, or context-bearing packages must resolve one live
  definition across standalone and composed execution.
- TypeScript type identity:
  the same package must not appear through divergent physical paths that create
  distinct type identities or regressions such as `TS2742`.
- Explicit ownership:
  only the selected standalone or composed root owns install state.
- Live source linkage:
  cross-repo local dependencies resolve to the real source files exposed
  through `repos/*`.

Within the supported pnpm live-worktree model, only pnpm's global virtual
store provides the path-collapsing needed to preserve that identity-
convergence invariant.

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
- effective dependency inputs:
  the canonical dependency-relevant inputs for a selected topology, for example
  manifests, lockfiles, patches, install settings, and generated aggregate
  inputs, that determine dependency materialization and whether equivalent
  graphs collapse to the same global virtual store entries
- pnpm content-addressable store:
  pnpm's global file store containing the package files from which virtual
  store entries are materialized
- global virtual store:
  the central virtual store at `<store-path>/links` used when
  `enableGlobalVirtualStore` is enabled; entries are keyed by dependency graph
  hash and hard linked from the pnpm content-addressable store
- projection state:
  topology-local derived install state, such as linked workspace
  `node_modules`, rendered from the selected topology's virtual store and not
  independently authoritative
- peer-sensitive package family:
  a package family whose runtime identity matters and therefore must not split
  across one composed runtime graph, for example React, Emotion, and similar
  context- or singleton-bearing packages

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

## Identity Convergence

- The supported pnpm live-worktree model is `node-linker=hoisted` with
  `enableGlobalVirtualStore=true`.
- The reason is not merely performance. The same physical source tree may be
  viewed through standalone and composed topology roots at the same time, and
  that must not produce different physical instances of the same dependency.
- That convergence is required both for JavaScript runtime identity and for
  TypeScript type identity.
- Within pnpm, GVS is the required path-collapsing primitive that makes
  equivalent graphs point at one physical dependency instance.
- GVS is not the install ownership model. Ownership still comes from the
  selected standalone or composed root.

## Aggregate Topology Generation

The aggregate root is generated from the composed topology and must include:

- the explicit workspace member list for the composed topology
- composition-local `link:` dependencies for cross-repo local packages
- the aggregate dependency closure for linked cross-repo packages
- a composition-local aggregate lockfile derived from the composed topology

Aggregate workspace files should be recomposed from package-local Genie outputs
and their non-emitted metadata, not maintained as a second handwritten member
list.

That package-local metadata must remain static and import-time safe. Runtime
generation context is used only by projection helpers when rendering aggregate
or package-level workspace files.

Aggregate generation is topology-local:

- repos may share task and builder code
- each composed repo generates its own aggregate root files
- standalone repo lockfiles remain authoritative only for standalone topologies

The generated aggregate root files and aggregate dependency closure together
form the effective dependency inputs for the composed topology.

Those inputs must be stable and canonical enough that equivalent standalone and
composed graphs for the same physical source tree collapse to the same global
virtual store entries instead of materializing path-local duplicates.

In particular, machine-local checkout paths, megarepo store paths, and other
non-semantic filesystem details must not perturb the effective dependency
inputs.

The aggregate dependency closure must contain the external packages needed so
that linked packages resolve their direct and shared runtime dependencies from
the composed topology at runtime.

Version selection for the aggregate dependency closure must be deliberate and
validated. The implementation must not silently let the aggregate root drift
from what linked packages declare.

## Peer-Sensitive Package Convergence

Peer-sensitive package convergence is a special case of the identity-convergence
invariant.

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
- Package-local `node_modules` inside workspace packages are acceptable only as
  derived projection state of the active topology. They must not be
  independently install-owned or allowed to diverge from the active topology.

## Local Cross-Repo Resolution

- Cross-repo local dependencies resolve to the real source files exposed
  through `repos/*`.
- Local source edits must become visible to dependents without another
  install step.
- If a dependency is intended to resolve locally but does not, the mismatch
  must be surfaced explicitly.

## Linker and Runtime Model

This linker choice is required because:

- it prevents package-local install state from leaking back into linked
  packages in the way the isolated linker does
- it allows standalone and composed topologies to coexist in the same source
  tree
- it makes equivalent standalone and composed graphs converge to one physical
  dependency instance instead of resolving the same package through divergent
  topology-local virtual store paths

The model must not depend on undeclared imports being satisfied accidentally by
hoisting. If such an edge exists, it must be fixed in dependency metadata or
with explicit package-manager metadata such as `packageExtensions`.

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
coherent under the same hoisted + GVS model.

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
- compute or validate the effective dependency inputs for the selected topology
  before dependency materialization
- enforce the supported hoisted + GVS live-worktree install settings
- ensure nested standalone repos are ready before a composed install depends
  on them, preferably by depending on their own repo-local install tasks
- keep topology-local projection state distinct from reusable pnpm store and
  global virtual store state
- apply the required runtime symlink-preservation flags for composed
  execution
- validate that aggregate topology generation and dependency closure are in
  sync before install and runtime execution

Managed tooling should prefer:

- reusing upstream repo-local task entrypoints over reimplementing raw package
  manager commands in the composed repo
- reusing upstream Genie definitions over duplicating package and workspace
  metadata locally
- reusing shared CI helpers while keeping generated aggregate files
  topology-local

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

Any CI job that validates the supported pnpm live-worktree model must enable
GVS explicitly.

Composed validation must cover:

- aggregate root inputs are generated locally for the composed repo
- aggregate topology generation
- aggregate dependency closure generation
- effective dependency inputs remain stable across equivalent checkouts
- equivalent standalone and composed graphs for the same physical source tree
  converge to one package instance under GVS
- peer-sensitive package convergence
- standalone-first then composed install
- composed-first then standalone install
- standalone runtime coherence
- composed runtime coherence
- TypeScript / project-reference coherence with no duplicate-path identity
  regressions such as `TS2742`
- duplicate-instance detection for shared runtime dependencies
- live cross-repo edit propagation

The validation matrix must include at least one realistic multi-repo smoke
test with actual `repos/*` symlinked paths.

## Conformance

An implementation conforms to this spec only if it preserves the invariants
above while satisfying
[requirements.md](./requirements.md)
for the supported package set.
