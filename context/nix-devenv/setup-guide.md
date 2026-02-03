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
  effectUtils = inputs.effect-utils;
  effectUtilsRoot = effectUtils.outPath;
  taskModules = effectUtils.devenvModules.tasks;
in
{
  imports = [
    effectUtils.devenvModules.dt
    taskModules.genie
    taskModules.megarepo
    (taskModules.pnpm { packages = [ "." ]; })
    (taskModules.ts { tsconfigFile = "tsconfig.json"; })
    (taskModules.setup {
      tasks = [
        "megarepo:sync"
        "pnpm:install"
        "genie:run"
        "ts:build"
      ];
    })
  ];

  packages = [
    pkgs.nodejs_24
    pkgs.bun
    # CLIs from effect-utils (Nix-built packages)
    effectUtils.packages.${pkgs.system}.genie
    effectUtils.packages.${pkgs.system}.megarepo
  ];

  enterShell = ''
    # effect-utils packages available for Node resolution
    export NODE_PATH="${effectUtilsRoot}/packages''${NODE_PATH:+:$NODE_PATH}"
  '';
}
```

See [tasks.md](./tasks/tasks.md) for available task modules.

See [cli-patterns.md](./cli-patterns.md) for when to use Nix packages vs source-based CLIs.

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
source_env_if_exists .envrc.local
if has devenv && test -f devenv.nix; then
    use devenv
fi
```

The megarepo root path is available as `DEVENV_ROOT` (provided by devenv).

### .gitignore

```
.direnv/
.devenv/
repos/
result
node_modules/
```

Commit `devenv.lock` and `megarepo.lock` (do not ignore).

### .oxlintrc.json.genie.ts

```typescript
import { oxlintConfig } from './genie/internal.ts'

export default oxlintConfig()
```

### .oxfmtrc.json.genie.ts

```typescript
import { oxfmtConfig } from './genie/internal.ts'

export default oxfmtConfig()
```

These generate the linter and formatter configs. Run `genie` to create `.oxlintrc.json` and `.oxfmtrc.json`.

## Initial Setup

```bash
direnv allow
```

The `megarepo:sync` task runs automatically during devenv shell entry on fresh clone/worktree, so manual `mr sync` is typically not needed. Use `mr status` to check sync state or `mr sync` to force re-sync.

## Updating Inputs

```bash
devenv update                    # Update all inputs
devenv update effect-utils       # Update specific input
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
