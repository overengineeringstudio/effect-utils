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

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
  '';
}
```

## .envrc

```bash
export WORKSPACE_ROOT=$(pwd)
use devenv
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

## Notes

- devenv uses GitHub URLs by default
- Changes to effect-utils need to be pushed to GitHub before they're available
- For local development with unpushed changes, consider the [pure flake setup](./nix-flake-setup.md) with `--override-input`

## Test Setup

See `tests/mk-bun-cli` for the fixture repos and runner that exercise
flakes, devenv, and peer-repo composition.

## References

- [devenv inputs](https://devenv.sh/inputs/)
- [devenv getting started](https://devenv.sh/getting-started/)
