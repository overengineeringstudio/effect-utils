# Local Build Requirements

Scope: local builds for Bun-compiled CLIs in megarepo workspaces.

1. Uncommitted files must be visible to the build (no git+file snapshot loss).
2. No `--impure` usage; evaluation and builds stay pure.
3. No copying `node_modules` into outputs; dependencies come from fixed-output Bun snapshots.
4. Works in effect-utils and peer repos, via flakes and via devenv.
5. Respects megarepo workspace layout; mk-bun-cli does not create workspace symlinks.
6. Deterministic inputs; no hidden host paths or transient caches in the build graph.
7. Local builds should be fast by avoiding `path:.` hashing on large trees.
8. Clear, actionable errors for stale `bunDepsHash` / lockfile drift.
9. A smoke test must run for each built CLI.
10. No new global tooling requirements; use existing `nix`, `bun`, `rsync`.
11. Reusable/composable: peer repos can share the same staging/build plumbing without copy-pasting or bespoke per-repo hacks.
12. Avoid separate clean/dirty build paths; prefer a single local workspace path.
