# pnpm Repo-Boundary GVS Spec

This document specifies the intended `pnpm` install model for standalone
repos and composed megarepos.

It builds on
[requirements.md](./requirements.md).

Open design questions are tracked separately in
[open-questions.md](./open-questions.md).

## Scope

This spec defines:

- workspace topology boundaries
- install ownership
- cross-repo local dependency resolution
- lockfile and publish behavior
- managed-shell and CI expectations

This spec does not yet define the final solution for peer-sensitive runtime
packages. That topic remains outside the conformance boundary until the open
questions are resolved.

## Terminology

- standalone topology:
  one repo root, that repo's workspace members, and that repo's canonical
  manifests and lockfile
- composed topology:
  one aggregate root, its workspace members, and its canonical manifests and
  lockfile
- install owner:
  the workspace root whose install is allowed to materialize dependency state
  for that topology
- composition-local link:
  private composed-topology metadata that resolves a package name to a local
  source path across a repo boundary

## Topology Model

### Intra-repo topology

- `workspace:` is the protocol inside a standalone repo.
- Each standalone repo remains a normal `pnpm` workspace with its own
  manifests and lockfile.

### Cross-repo topology

- `workspace:` is not used across repo boundaries.
- Cross-repo local dependency resolution is expressed only through
  composition-local links.
- Composition-local links are private to the composed topology and must not
  become part of publishable standalone manifests.

## Install Ownership

- Each standalone repo is the install owner for its own standalone topology.
- A composed root is the install owner only for its own composed topology.
- A composed install must not rewrite nested repo root lockfiles or nested
  repo root `node_modules`.

### Nested repo readiness

- A composed install may only run against nested repos that already satisfy
  their standalone install state.
- If a linked nested repo is not ready, the composed install must fail before
  creating divergent local state.

## Cross-Repo Local Resolution

- Cross-repo local dependencies must resolve to the real source files exposed
  through `repos/*`.
- Local source edits must become visible to dependents without another
  install step.
- If a dependency is intended to resolve locally but does not, the mismatch
  must be surfaced explicitly.

## Global Virtual Store

- `enableGlobalVirtualStore=true` is part of the supported composed-dev
  install model.
- GVS is a path-collapsing mechanism, not the ownership model.
- The implementation must not assume that GVS alone makes multiple install
  owners safe.

## Managed Tooling

- Supported install entrypoints are managed-shell entrypoints.
- The `pnpm` executable in the managed shell must enforce the supported
  topology rules.

At minimum the managed wrapper must:

- reject unsupported nested install entrypoints in a composed worktree
- route users toward the canonical install command
- verify nested repo readiness before allowing a composed install

Package-manager lifecycle scripts are not sufficient as the primary guard.

## Lockfiles and Publishing

- Standalone repos keep their own standalone lockfiles.
- A composed topology may keep its own aggregate lockfile.
- Both lockfile kinds must stay checkout-portable and topology-specific.
- Publishable standalone manifests must remain free of composition-local link
  metadata.

## CI

- CI must validate standalone topologies and composed topologies separately.
- Any CI job that validates the composed-dev model must enable GVS
  explicitly.
- Composed CI must verify:
  - nested repo install prerequisites
  - local-link resolution
  - duplicate-instance detection for the supported package set

## Conformance

An implementation conforms to this spec only if it preserves the invariants
above while satisfying
[requirements.md](./requirements.md)
for the supported package set.
