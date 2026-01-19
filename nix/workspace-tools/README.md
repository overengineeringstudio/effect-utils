# Workspace Tools (Nix)

Reusable Nix helpers for building Bun binaries and wiring direnv/devenv
auto-rebuild behavior. These are pure, dotdot-friendly, and designed for
local dirty iteration without copying `node_modules`.

## Layout

- `lib/`
  - `mk-bun-cli.nix` — Bun binary builder (deterministic, local file deps).
  - `cli-build-stamp.nix` — build stamp helper for CLIs.
  - `update-bun-hashes.nix` — helper to refresh bunDeps hashes.
- `env/direnv/`
  - `auto-rebuild-clis.nix` — checks expected outputs vs PATH, rebuilds when stale.
  - `peer-envrc.nix` — generic peer helper (env overrides).
  - `peer-envrc-effect-utils.nix` — sibling effect-utils one-liner helper.
  - `effect-utils-envrc.nix` — effect-utils repo helper (devenv + auto-rebuild).
- `docs/`
  - `README.md` — index to streamlining notes.

## Flake Exports

From `effect-utils/flake.nix`:

```nix
direnv.autoRebuildClis
direnv.peerEnvrc
direnv.peerEnvrcEffectUtils
direnv.effectUtilsEnvrc

lib.mkBunCli
lib.cliBuildStamp
```

## Quick Usage

Build a Bun CLI:

```nix
mkBunCli = import "${effect-utils}/nix/workspace-tools/lib/mk-bun-cli.nix" {
  inherit pkgs pkgsUnstable;
};
```

Peer repo `.envrc`:

```bash
source "$(nix eval --raw --no-write-lock-file "$WORKSPACE_ROOT/../effect-utils#direnv.peerEnvrcEffectUtils")"
```
