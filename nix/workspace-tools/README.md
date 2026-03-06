# Workspace Tools (Nix)

Reusable Nix helpers for building Bun CLIs and shared CLI utilities. These are
pure and designed to work in both megarepo workspaces and standalone repos.

## Layout

- `lib/`
  - `mk-bun-cli.nix` — Bun binary builder (deterministic, local file deps).
  - `mk-pnpm-cli.nix` — pnpm + bun compile builder for workspace CLIs.
  - `mk-pnpm-deps.nix` — FOD helper for fetching pnpm deps with store normalization (phantom package pruning, CAS/index canonicalization).
  - `pnpm-platform.nix` — pnpm `supportedArchitectures` setup for cross-platform hashes.
  - `cli-build-stamp.nix` — build stamp helper for CLIs.
  - `update-bun-hashes.nix` — helper to refresh bunDeps hashes.
- `docs/`
  - `README.md` — index to mk-bun-cli notes.

## Flake Exports

From `effect-utils/flake.nix`:

```nix
lib.mkBunCli
lib.cliBuildStamp
apps.update-bun-hashes
```

## Quick Usage

Build a Bun CLI:

```nix
mkBunCli = import "${effect-utils}/nix/workspace-tools/lib/mk-bun-cli.nix" {
  inherit pkgs;
};
```
