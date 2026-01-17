# Dirty Build Requirements

Scope: local "dirty" builds for Bun-compiled CLIs in dotdot workspaces.

1. Uncommitted files must be visible to the build (no git+file snapshot loss).
2. No `--impure` usage; evaluation and builds stay pure.
3. No copying `node_modules` into outputs; dependencies come from fixed-output Bun snapshots.
4. Works in effect-utils and peer repos, via flakes and via devenv/direnv.
5. Respects dotdot workspace layout; mk-bun-cli does not run `dotdot link`.
6. Deterministic inputs; no hidden host paths or transient caches in the build graph.
7. Dirty builds should be close to clean build time (fast iteration).
8. Clear, actionable errors for stale `bunDepsHash` / lockfile drift.
9. A smoke test must run for each built CLI.
10. No new global tooling requirements; use existing `nix`, `bun`, `rsync`.
11. Reusable/composable: peer repos can share the same staging/build plumbing without copy-pasting or bespoke per-repo hacks.
12. Dirty mode should not require a separate flake tree; staging stays under `.direnv` and is driven by a single flag.
