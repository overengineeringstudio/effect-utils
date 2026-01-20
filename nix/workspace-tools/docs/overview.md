# Overview

Date: 2026-01-16  
Scope: effect-utils Nix/direnv/devenv workflow streamlining

## Goals Recap

- Keep Nix builds pure (no --impure) and deterministic.
- Fast builds and good re-use across packages/repos.
- Support dirty local changes in dotdot workspaces.
- Avoid copying heavy artifacts (node_modules).
- Keep peer repo usage minimal and composable.
- Improve error messages and reduce setup complexity.

## Constraints

- No impure builds, even for dirty local iteration.
- Must work in effect-utils and peer repos (devenv + flake).
- Do not copy node_modules into build output.
- Default to dotdot workspace layout (siblings).

## What Changed (Summary)

- Introduced reusable direnv helpers so peer repos can keep .envrc to a one-liner.
- Added a minimal staging workflow for dirty builds under `.direnv/cli-workspace`.
- Added flake outputs for direnv helper scripts.
- Aligned devenv bunDeps hashes with flake build hashes.
- Documented behavior, customization, and reuse patterns.

## Key Implementation Details

- New helper outputs in `flake.nix` (see `docs/README.md` for the full list).
- New helper scripts under `env/direnv/` (see `docs/README.md` for paths).
- Peer repo usage is now:
  - `source "$(nix eval --raw --no-write-lock-file "$WORKSPACE_ROOT/../effect-utils#direnv.peerEnvrcEffectUtils")"`
- Workspace-wide nixpkgs pin via `nix/workspace-flake`:
  - Repos follow `workspace/nixpkgs` and stay self-contained via the GitHub URL.
  - Direnv helpers auto-override the workspace input when the local workspace flake exists.
- Dirty builds stage a minimal workspace under `.direnv/cli-workspace` using rsync
  with `.gitignore` filtering and explicit includes.
- Staging now strips `-dirty` from `NIX_CLI_DIRTY_PACKAGES` so include paths resolve
  to real package directories.

## Tradeoffs and Rationale

- **Staged workspace vs direct path**: staging keeps builds pure and avoids
  `path:` restrictions outside the flake root, at the cost of a lightweight
  rsync step.
- **One-liner peer usage**: favors ergonomics for common sibling layout; advanced
  overrides still available via env vars.
- **Skip typecheck in dirty builds**: avoids TS6305 when references are missing,
  but reduces typecheck coverage for dirty builds.
- **No `node_modules` copying**: bunDeps are linked/symlinked into the staged
  workspace to keep outputs lean.

## Documentation Updates

- `context/monorepo-compose/devenv-setup.md`
  - One-liner peer repo template.
  - Behavior matrix (effect-utils vs peer, auto-rebuild vs dirty mode).
  - Advanced overrides section.
  - Reuse for peer repo CLIs (with flake/output example).
- `context/bun-cli-build/README.md`
- `context/bun-cli-build/requirements.md`

## Files Touched (High-Level)

- `flake.nix`
- `devenv.nix`
- `nix/workspace-tools/lib/mk-bun-cli.nix`
- `nix/workspace-tools/env/direnv/*.nix`
- `context/monorepo-compose/devenv-setup.md`
- `context/bun-cli-build/*`
