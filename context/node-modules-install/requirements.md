# Node Modules Install Requirements

## Context

We want a principled `node_modules` install model for standalone repos and
composed megarepos. Megarepo composition exposes nested repos through
symlinked `repos/*` entries, but each worktree still has one canonical
physical location in the filesystem.

The install model must support standalone repo development, composed
cross-repo development, and live source iteration across repo boundaries
without leaving the worktree in a divergent or order-dependent install
state.

## Example Layout

```text
~/.megarepo/.../composed-root/refs/heads/main/
  package.json                  # composed aggregate root
  packages/
    app/
  repos/
    repo-a -> ~/.megarepo/.../repo-a/refs/heads/main
    repo-b -> ~/.megarepo/.../repo-b/refs/heads/main

~/.megarepo/.../repo-a/refs/heads/main/
  package.json                  # standalone repo root
  packages/
    core/
```

The important property is that
`~/.megarepo/.../composed-root/refs/heads/main/repos/repo-a/...` and the
standalone `repo-a` worktree path refer to the same physical files. Any
install model must account for that.

In these requirements, a `workspace topology` means the chosen workspace
root, its workspace member packages, and the canonical manifests and
lockfile that define installs for that workspace.

## Assumptions

- A1 - These requirements build on
  [Nix & Devenv Specification](../nix-devenv/requirements.md) and the
  [megarepo spec](../../packages/@overeng/megarepo/docs/spec.md).
- A2 - The megarepo worktree path is canonical; we should not require copied
  dev worktrees or separate staged checkouts just to make local iteration
  safe.

## Acceptable Tradeoffs

- T1 - Listing workspace members explicitly instead of using workspace globs
  is acceptable. We can generate the explicit member list via Genie.
- T2 - Keeping a per-package lockfile for standalone repos is acceptable, as
  long as a composed megarepo may also maintain its own aggregate lockfile
  for the composed workspace topology.
- T3 - Using an aggregate package or aggregate root manifest for the composed
  workspace topology is acceptable. Package managers are usually optimized
  for monorepos, so a canonical aggregate root often gives the best install
  and update performance as long as standalone repos remain valid.
- T4 - Using a hoisted linker is acceptable if the workspace provides
  compensating checks for undeclared dependencies and preserves coherent
  runtime resolution across standalone and composed topologies.

## Requirements

### Must be deterministic

- R1 - Supported install flows must converge to one canonical final install
  state for a given worktree and workspace topology, independent of install
  order or current working directory. Multiple topologies may coexist
  against the same physical source tree, but each topology must still have a
  canonical final install state and there must be no duplicate live
  instances of the same dependency across one composed runtime graph.
- R2 - Lockfiles must be reproducible and checkout-portable: no absolute
  paths, machine-local paths, or hidden host-specific state. A composed
  lockfile may encode the composed workspace topology, but it must remain
  stable across machines and fresh checkouts of that workspace topology.

### Must preserve standalone and composed validity in megarepo

- R3 - Every repo must remain a valid standalone repo with its own manifests
  and lockfiles. Composition must not require composed-only manifest
  conventions that break standalone installs.
- R4 - In a composed worktree, nested repos must remain runnable and hackable
  through `repos/<repo>` paths, and cross-repo local dependencies must
  resolve to live source so source edits propagate without reinstall. Local
  dependency linking must be direct enough that code changes become visible
  to dependents without requiring another install step.
- R5 - Each package must be self-contained in the sense that it and its local
  workspace closure can be materialized into a minimal standalone workspace
  that installs, builds, and runs correctly.
- R6 - The model must work with symlinked `repos/*` entries as produced by
  megarepo. Workspace membership may be generated explicitly; the design must
  not depend on Bun discovering symlinked workspace globs.
- R7 - The model must scale across multiple composition layers, for example
  `repo-x -> repo-y -> repo-z`, without changing the core install semantics.

### Must be explicit and safe

- R8 - The active install owner for a worktree must be explicit and
  mechanically derivable from the workspace topology. Install and runtime
  entrypoints must be topology-aware, and ambiguous or unsupported
  entrypoints must fail fast instead of silently materializing the wrong
  topology.
- R9 - If a dependency is intended to resolve to a local workspace member but
  does not, the system must surface that mismatch clearly.

### Must avoid accidental dependency masking

- R10 - The install model must not silently make undeclared dependencies
  appear valid. If the chosen linker or layout weakens package isolation, the
  workspace must provide compensating checks so dependency declarations remain
  truthful.

### Must be verifiable

- R11 - We need repro coverage for standalone installs, composed installs,
  mixed or incorrect install entrypoints, cross-repo live edit propagation,
  isolated package-closure materialization, and duplicate-instance detection.
  We also need at least one realistic multi-repo smoke test, not just minimal
  toy workspaces.
