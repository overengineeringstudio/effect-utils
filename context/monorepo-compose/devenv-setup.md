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
