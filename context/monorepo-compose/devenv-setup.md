# devenv Setup

Use devenv with GitHub URLs in `devenv.yaml`. Each repo pins its own `nixpkgs`;
alignment across repos is optional. Override inputs only when you need local
changes.

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
  system = pkgs.stdenv.hostPlatform.system;
  effectUtilsPkgs = inputs.effect-utils.packages.${system};
  cliBuildStamp = inputs.effect-utils.lib.cliBuildStamp { inherit pkgs; };
in
{
  packages = [
    pkgs.bun
    pkgs.nodejs_24
    effectUtilsPkgs.genie
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
source_env_if_exists ./.envrc.generated.megarepo
use devenv
```

## .gitignore

```
.direnv/
.devenv/
result
```

Keep `devenv.lock` checked in (do not ignore it). If it’s ignored, devenv will
re-resolve inputs on every shell entry which makes `direnv reload` slow and
causes repeated lock updates.

## Usage

```bash
devenv shell
direnv allow
```

## Updating Inputs

```bash
devenv update
devenv update effect-utils
```

## Local Overrides (Unpushed Changes)

In a megarepo, prefer running builds against the local workspace path:

```bash
nix build "path:$MEGAREPO_NIX_WORKSPACE#packages.<system>.my-repo.<target>"
```

To override a dependency with a local checkout (e.g. effect-utils), use `--override-input`:

```bash
devenv shell --override-input effect-utils path:../effect-utils
```

You can also wire the override into `.envrc`:

```bash
use devenv --override-input effect-utils path:../effect-utils
```

Run `direnv allow` after updating `.envrc`.

## Refreshing direnv

```bash
rm -rf .devenv
direnv reload
```

If the direnv cache itself is stale, remove `.direnv` too.

- devenv uses GitHub URLs by default, so unpushed changes are not picked up
- override the input (above) to use unpushed sibling changes locally
- for local development with unpushed changes, the [pure flake setup](./nix-flake-setup.md) and `--override-input` behave the same

## CLI build stamp

`cliBuildStamp.shellHook` exports `NIX_CLI_BUILD_STAMP` using `WORKSPACE_ROOT`
or `CLI_BUILD_STAMP_ROOT`. The CLI version helper uses the stamp when the build
placeholder stays in the binary, or appends the stamp to the injected build
version for a combined output.

## Test Setup

See `nix/workspace-tools/lib/mk-bun-cli/tests` for the fixture repos and runner that exercise
flakes, devenv, and peer-repo composition (including dirty local changes).

## References

- [devenv inputs](https://devenv.sh/inputs/)
- [devenv getting started](https://devenv.sh/getting-started/)
