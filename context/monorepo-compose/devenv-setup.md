# devenv Setup

Use devenv with GitHub URLs for a declarative development environment.

## devenv.yaml

```yaml
inputs:
  nixpkgs:
    url: github:NixOS/nixpkgs/nixos-unstable
  effect-utils:
    url: github:overengineeringstudio/effect-utils
```

## devenv.nix

```nix
{ pkgs, inputs, ... }:
let
  cliPackages = inputs.effect-utils.lib.mkCliPackages {
    inherit pkgs;
    pkgsUnstable = pkgs;
  };
in
{
  packages = [
    pkgs.bun
    pkgs.nodejs_24
    cliPackages.genie
    cliPackages.dotdot
  ];
}
```

## .envrc

```bash
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
.devenv.flake.nix
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

## Notes

- devenv uses GitHub URLs by default
- Changes to effect-utils need to be pushed to GitHub before they're available
- For local development with unpushed changes, consider the [pure flake setup](./nix-flake-setup.md) with `--override-input`

## Test Setup

See `tests/mk-bun-cli` for the fixture repos and runner that exercise
flakes, devenv, and peer-repo composition (including dirty local changes).

## References

- [devenv inputs](https://devenv.sh/inputs/)
- [devenv getting started](https://devenv.sh/getting-started/)
