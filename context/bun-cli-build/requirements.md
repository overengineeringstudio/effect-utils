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

## Acceptable Tradeoffs

- T1 - Materializing filtered build inputs is acceptable if the materialized
  view is derived mechanically from the canonical workspace topology.
- T2 - Installing dependencies inside the Nix build is acceptable as long as
  the build reuses the canonical manifests and lockfiles for the selected
  topology instead of copying developer `node_modules`.
- T3 - Standalone and composed topologies may use different lockfiles, as
  long as the build selects the correct one explicitly and reproducibly.

## Requirements

### Must preserve source and topology semantics

- R1 - Uncommitted files must be visible to the build. The build must not
  silently fall back to a git snapshot that drops local source changes.
- R2 - The build must reuse the existing manifests and lockfiles for the
  selected topology instead of inventing bespoke build-only package metadata.
- R3 - The CLI entrypoint must remain valid as part of its standalone repo
  topology, including its standalone lockfile when one exists.
- R4 - The build must respect the canonical megarepo workspace topology and
  install-owner model. `mk-bun-cli` may materialize filtered build inputs,
  but it must not create a second in-place install owner or depend on
  synthetic workspace symlinks.

### Must be pure and deterministic

- R5 - No `--impure` usage. Evaluation and builds must stay pure.
- R6 - The build must not copy `node_modules` into outputs. It may
  materialize filtered inputs, but it must install its own dependencies
  inside the Nix build using the same package-manager mechanism as the normal
  workspace install model.
- R7 - Build inputs must be deterministic. Hidden host paths, transient
  caches, and ambient machine state must not influence the build graph.
- R8 - The dependency hash must be stable and platform-agnostic. The same
  logical dependency inputs and selected topology must produce the same dep
  hash across supported systems.
- R9 - Errors for stale `bunDepsHash`, lockfile drift, or wrong topology
  selection must be clear and actionable.

### Must be practical and reusable

- R10 - Local builds should be fast and should avoid `path:.` hashing across
  unnecessarily large trees.
- R11 - The model must work in effect-utils and peer repos, via flakes and
  via devenv.
- R12 - The build plumbing must be reusable across peer repos without
  copy-pasting or bespoke per-repo hacks.
- R13 - No new global tooling requirements. The system should use the
  existing `nix`, `bun`, and `rsync` toolchain.

### Must be verifiable

- R14 - A smoke test must run for each built CLI.
