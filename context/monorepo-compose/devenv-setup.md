# devenv Setup

Use devenv with GitHub URLs for a declarative development environment.

## devenv.yaml

```yaml
inputs:
  nixpkgs:
    url: github:NixOS/nixpkgs/release-25.11
  nixpkgsUnstable:
    url: github:NixOS/nixpkgs/nixos-unstable
  effect-utils:
    url: github:overengineeringstudio/effect-utils
```

## devenv.nix

```nix
{ pkgs, inputs, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
  pkgsUnstable = import inputs.nixpkgsUnstable { inherit system; };
  cliPackages = inputs.effect-utils.lib.mkCliPackages {
    inherit pkgs pkgsUnstable;
  };
  cliBuildStamp = inputs.effect-utils.lib.cliBuildStamp { inherit pkgs; };
in
{
  packages = [
    pkgsUnstable.bun
    pkgsUnstable.nodejs_24
    cliPackages.genie
    cliPackages.dotdot
    cliBuildStamp.package
  ];

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
    ${cliBuildStamp.shellHook}
  '';
}
```

## .envrc

```bash
export WORKSPACE_ROOT=$(pwd)
if command -v nix-shell &> /dev/null
then
  eval "$(devenv direnvrc)"
  use devenv
fi
```

## .gitignore

```
.direnv/
.devenv/
devenv.lock
result
```

## Usage

```bash
# Enter the development shell
devenv shell

# Or with direnv (auto-activates)
direnv allow
```

## Updating Inputs

```bash
# Update all inputs to latest
devenv update

# Update specific input
devenv update effect-utils
```

## Local Overrides (Unpushed Changes)

To use local, unpushed changes from a sibling checkout, override the input:

```bash
# From your repo root (sibling of ../effect-utils)
devenv shell --override-input effect-utils path:../effect-utils
```

This keeps the config pinned to GitHub in `devenv.yaml` but lets you iterate
locally without pushing.

### direnv option

You can also wire the override into `.envrc`:

```bash
use devenv --override-input effect-utils path:../effect-utils
```

Run `direnv allow` after updating `.envrc`.

### direnv refresh

To force a full direnv rebuild without editing `.envrc`:

```bash
rm -rf .devenv
direnv reload
```

If the direnv cache itself is stale, remove `.direnv` too.

By default, `direnv reload` auto-rebuilds Nix CLIs when they are stale. The
auto-rebuild avoids creating `./result` symlinks in the repo. To disable
auto-rebuilds entirely, set `MONO_AUTO_REBUILD=0` (for example in
`.envrc.local`):

```bash
export MONO_AUTO_REBUILD=0
direnv reload
```

The auto-rebuild helper is loaded from the flake output
`direnv.autoRebuildClis`, and the checks use `cliOutPaths` to compare expected
store paths with the current `PATH`. By default, auto-rebuilds use the flake
ref (`.`) for faster evals. Set `NIX_CLI_DIRTY=1` to switch to a staged
workspace under `.direnv/cli-workspace` and pick up uncommitted changes. In
dirty mode, the helper builds `genie-dirty`, `dotdot-dirty`, and `mono-dirty`
and compares `cliOutPathsDirty` against the `genie`, `dotdot`, and `mono`
binaries in `PATH`. The helper syncs a minimal workspace into
`.direnv/cli-workspace` using a single `rsync` include list plus `.gitignore`
filtering, keeping the path flake small and pure while avoiding heavy
artifacts. The workspace directory lives under `.direnv` (already git-ignored).

Peer repo template (drop into that repo’s `.envrc`):

```bash
# Auto-rebuild Nix CLIs on reload; set MONO_AUTO_REBUILD=0 to disable.
# Set NIX_CLI_DIRTY=1 to stage a dirty workspace under .direnv/cli-workspace.
# Load effect-utils peer CLI helper (details in this doc).
source "$(nix eval --raw --no-write-lock-file "$WORKSPACE_ROOT/../effect-utils#direnv.peerEnvrcEffectUtils")"
```

Advanced overrides (only needed when customizing the CLI set):

```bash
# Space-separated lists:
export NIX_CLI_PACKAGES="my-cli other-cli"
# Dirty package list can use -dirty suffixes; staging strips them automatically.
export NIX_CLI_DIRTY_PACKAGES="my-cli-dirty other-cli-dirty"
# Override the attr names if your flake uses different ones.
export NIX_CLI_OUT_PATHS_ATTR="cliOutPaths"
export NIX_CLI_DIRTY_OUT_PATHS_ATTR="cliOutPathsDirty"
```

## CLI helper behavior

The `direnv.peerEnvrcEffectUtils` helper targets the shared effect-utils CLIs
(`genie`, `dotdot`, `mono`) and keeps them current during `direnv reload`.

Behavior matrix:

- **Effect-utils repo**
  - Auto-rebuild checks `cliOutPaths` vs `PATH` and rebuilds via `nix build` if stale.
  - Dirty builds use `NIX_CLI_DIRTY=1` to stage `.direnv/cli-workspace` and build `*-dirty`.
  - `MONO_AUTO_REBUILD=0` disables the auto-rebuild check.
- **Peer repos (sibling layout)**
  - Auto-rebuild still targets effect-utils CLIs and reloads the peer shell on updates.
  - Dirty builds stage into the effect-utils repo (`../effect-utils/.direnv/cli-workspace`).
  - `MONO_AUTO_REBUILD=0` disables the auto-rebuild check.

Auto-rebuild vs dirty mode:

- Auto-rebuild decides **when** to rebuild (stale binaries).
- Dirty mode decides **what** to build (staged dirty workspace vs pure flake).

## Customizing the CLI set

Use env overrides when the default CLI list is not enough:

- **Only rebuild a subset**: set `NIX_CLI_PACKAGES="genie"` and
  `NIX_CLI_DIRTY_PACKAGES="genie-dirty"`.
- **Extra CLIs**: if effect-utils exposes more packages, append them to the lists.
- **Alternative outPaths**: set `NIX_CLI_OUT_PATHS_ATTR` /
  `NIX_CLI_DIRTY_OUT_PATHS_ATTR` when a repo defines different attr names.

## Reusing the helper for peer repo CLIs

To manage CLIs defined in the peer repo itself, point the helper at the peer
repo flake and expose compatible outputs:

1. Add outputs to the peer repo flake:

```nix
{
  outputs = { self, ... }: {
    packages.<system>.my-cli = ...;
    packages.<system>.my-cli-dirty = ...;
    cliOutPaths = { my-cli = self.packages.<system>.my-cli.outPath; };
    cliOutPathsDirty = { my-cli = self.packages.<system>.my-cli-dirty.outPath; };
  };
}
```

2. Update the peer `.envrc`:

```bash
export NIX_CLI_PACKAGES="my-cli"
export NIX_CLI_DIRTY_PACKAGES="my-cli-dirty"
source "$(nix eval --raw --no-write-lock-file "$WORKSPACE_ROOT#direnv.peerEnvrc")"
```

3. Dirty mode still works: set `NIX_CLI_DIRTY=1` and the staged workspace is
   created under the peer repo’s `.direnv/cli-workspace`.

If the peer repo uses different attr names, set `NIX_CLI_OUT_PATHS_ATTR` /
`NIX_CLI_DIRTY_OUT_PATHS_ATTR` to match.

If you want a flag-driven refresh (requires touching `.envrc`), pass
`--refresh-eval-cache` to `use devenv`:

```bash
use devenv --refresh-eval-cache
```

## Notes

- devenv uses GitHub URLs by default, so unpushed changes are not picked up
- override the input (above) to use unpushed sibling changes locally
- for local development with unpushed changes, the [pure flake setup](./nix-flake-setup.md) and `--override-input` behave the same

## CLI build stamp

`cliBuildStamp.shellHook` exports `NIX_CLI_BUILD_STAMP` using `WORKSPACE_ROOT`
or `CLI_BUILD_STAMP_ROOT`. The CLI version helper uses the stamp when the build
placeholder stays in the binary, or appends the stamp to the injected build
version for a combined output.

## Test Setup

See `tests/mk-bun-cli` for the fixture repos and runner that exercise
flakes, devenv, and peer-repo composition (including dirty local changes).

## References

- [devenv inputs](https://devenv.sh/inputs/)
- [devenv getting started](https://devenv.sh/getting-started/)
