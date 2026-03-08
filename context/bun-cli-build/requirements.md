# Local Build Requirements

Scope: local builds for Bun-compiled CLIs in megarepo workspaces.

Assumptions:

- These requirements build on
  [Node Modules Install Requirements](../node-modules-install/requirements.md).

1. Uncommitted files must be visible to the build (no git+file snapshot loss).
2. No `--impure` usage; evaluation and builds stay pure.
3. The build must reuse the existing manifests and lockfiles for the selected
   topology instead of inventing bespoke build-only package metadata.
4. The CLI entrypoint must remain valid as part of its standalone repo
   topology, including its standalone lockfile when one exists.
5. No copying `node_modules` into outputs. The build may materialize filtered
   inputs, but it must install its own dependencies inside the Nix build
   using the same package-manager mechanism as the normal workspace install
   model.
6. Works in effect-utils and peer repos, via flakes and via devenv.
7. Respects the canonical megarepo workspace topology and install-owner
   model. `mk-bun-cli` may materialize filtered build inputs, but it must not
   create a second in-place install owner or depend on synthetic workspace
   symlinks.
8. Deterministic inputs; no hidden host paths or transient caches in the
   build graph.
9. Local builds should be fast by avoiding `path:.` hashing on large trees.
10. Clear, actionable errors for stale `bunDepsHash` or lockfile drift, and
    for selecting the wrong lockfile for the current topology.
11. A smoke test must run for each built CLI.
12. No new global tooling requirements; use existing `nix`, `bun`, `rsync`.
13. Reusable/composable: peer repos can share the same staging/build plumbing
    without copy-pasting or bespoke per-repo hacks.
14. Prefer a single canonical local workspace source of truth. Internal build
    staging or filtering is acceptable as an implementation detail, but the
    system must not require separate user-managed clean/dirty worktrees.
