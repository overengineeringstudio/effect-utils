# Local Build Requirements

## Context

These requirements cover local Nix builds for Bun-compiled CLIs in megarepo
workspaces.

They define how `mk-bun-cli` and related build plumbing should reuse the
workspace install model without depending on developer-owned `node_modules`
state.

## Assumptions

- A1 - These requirements build on
  [Node Modules Install Requirements](../node-modules-install/requirements.md).
- A2 - The local workspace path remains the canonical source of truth. Build
  internals may materialize filtered inputs, but the user should not need to
  manage separate clean or dirty worktrees.
- A3 - For the selected workspace topology, the canonical manifests and
  lockfile are already in a stable, self-contained state. A build-time
  install may realize that dependency graph, but it should not need to
  rewrite the lockfile or change dependency metadata to make the build work.

## Requirements

### Must preserve source and workspace topology semantics

- R1 - Uncommitted files must be visible to the build. The build must not
  silently fall back to a git snapshot that drops local source changes.
- R2 - The build must reuse the existing manifests and lockfiles for the
  selected workspace topology instead of inventing bespoke build-only
  package metadata.

### Must be pure and deterministic

- R3 - No `--impure` usage. Evaluation and builds must stay pure.
- R4 - The build must not copy `node_modules` into outputs. It may
  materialize filtered inputs, but it must install its own dependencies
  inside the Nix build using the same package-manager mechanism as the normal
  workspace install model.
- R5 - Build inputs must be deterministic. Hidden host paths, transient
  caches, and ambient machine state must not influence the build graph.
- R6 - The dependency hash must be stable and platform-agnostic. The same
  logical dependency inputs and selected workspace topology must produce the
  same dep hash across supported systems.
- R7 - Errors for stale `bunDepsHash`, lockfile drift, or wrong workspace
  topology selection must be clear and actionable.

### Must be practical and reusable

- R8 - Local builds should be fast and should avoid `path:.` hashing across
  unnecessarily large trees.
- R9 - The model must work in effect-utils and peer repos, via flakes and
  via devenv.
- R10 - The build plumbing must be reusable across peer repos without
  copy-pasting or bespoke per-repo hacks.
- R11 - No new global tooling requirements. The system should use the
  existing `nix`, `bun`, and `rsync` toolchain.

### Must be verifiable

- R12 - A smoke test must run for each built CLI.
