# Devenv Setup Guide

Devenv is the primary development workflow. Repos use `devenv.yaml` to declare inputs (pinned to GitHub URLs) and `devenv.nix` for shell configuration. Flakes define packages; devenv consumes them via inputs.

## File Templates

### megarepo.json

```json
{
  "members": {
    "effect-utils": "overengineeringstudio/effect-utils"
  },
  "generators": {
    "nix": { "enabled": true }
  }
}
```

See [repo-composition](../repo-composition/README.md) for member syntax and commands.

### devenv.yaml

```yaml
inputs:
  nixpkgs:
    url: github:cachix/devenv-nixpkgs/rolling
  effect-utils:
    url: github:overengineeringstudio/effect-utils
```

### devenv.nix

```nix
{ pkgs, inputs, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
  taskModules = inputs.effect-utils.devenvModules.tasks;
in
{
  imports = [
    inputs.effect-utils.devenvModules.dt
    taskModules.genie
    taskModules.megarepo
    (taskModules.pnpm { packages = [ "." ]; })
    (taskModules.ts { tsconfigFile = "tsconfig.json"; })
    (taskModules.setup { tasks = [ "megarepo:generate" "pnpm:install" "genie:run" "ts:build" ]; })
  ];

  packages = [
    pkgs.nodejs_22
    inputs.effect-utils.packages.${system}.genie
  ];

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
  '';
}
```

See [tasks.md](./tasks.md) for available task modules.

### flake.nix

```nix
{
  description = "My megarepo";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    effect-utils = {
      url = "github:overengineeringstudio/effect-utils";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, flake-utils, effect-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        packages = {
          # Add packages here - see flake-packages.md
        };
      });
}
```

See [flake-packages.md](./flake-packages.md) for package definitions.

### .envrc

```bash
source_env_if_exists ./.envrc.generated.megarepo
use devenv
```

The `.envrc.generated.megarepo` file is created by `mr generate nix` and sets `MEGAREPO_ROOT_*` and `MEGAREPO_NIX_WORKSPACE` environment variables.

### .gitignore

```
.direnv/
.devenv/
repos/
result
node_modules/
```

Commit `devenv.lock` and `megarepo.lock` (do not ignore).

## Initial Setup

```bash
mr sync
mr generate nix
direnv allow
```

## Updating Inputs

```bash
devenv update                    # Update all inputs
devenv update effect-utils       # Update specific input
```

## Local Overrides

When you need unpushed changes from a sibling repo:

```bash
# One-time override
devenv shell --override-input effect-utils path:../effect-utils

# Or wire into .envrc
use devenv --override-input effect-utils path:../effect-utils
```

Run `direnv allow` after updating `.envrc`.

## Building with Megarepo

Inside a megarepo, build from the generated workspace path (avoids slow `path:.` hashing):

```bash
nix build --no-write-lock-file --no-link \
  "path:$MEGAREPO_NIX_WORKSPACE#packages.aarch64-darwin.my-repo.my-cli"
```

Outside a megarepo, build normally:

```bash
nix build .#my-cli
```

## Refreshing direnv

```bash
rm -rf .devenv
direnv reload
```

If the direnv cache itself is stale, remove `.direnv` too.

## References

- [devenv inputs](https://devenv.sh/inputs/)
- [devenv composing](https://devenv.sh/composing-using-imports/)
- [devenv tasks](https://devenv.sh/tasks/)
