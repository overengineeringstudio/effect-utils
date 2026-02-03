# Flake Package Definitions

Flakes are the source of truth for package definitions. Devenv consumes flake outputs via inputs. This guide covers how to structure `flake.nix` for packages that devenv and CI can consume.

## Basic flake.nix Structure

```nix
{
  description = "My project";

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
          # See "Building CLIs" below for mkBunCli usage
        };
      });
}
```

## Input Follows

Deduplicate shared inputs to avoid multiple nixpkgs versions:

```nix
inputs = {
  nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  flake-utils.url = "github:numtide/flake-utils";
  effect-utils = {
    url = "github:overengineeringstudio/effect-utils";
    inputs.nixpkgs.follows = "nixpkgs";
    inputs.flake-utils.follows = "flake-utils";
  };
};
```

## Building CLIs

For building Bun-compiled TypeScript CLIs with `mkBunCli`, see [bun-cli-build](../bun-cli-build/README.md).

## CLI Pattern: Source for Dev, Nix for CI

We use a hybrid approach for CLIs:

| Context         | Method                   | Pros                             |
| --------------- | ------------------------ | -------------------------------- |
| **Development** | `mkSourceCli`            | Fast startup, no hash management |
| **CI/Releases** | Nix packages (`.#genie`) | Hermetic, reproducible           |

### Source-based CLIs for Devenv

Use `mkSourceCli` with the `root` parameter to bake in the effect-utils path:

```nix
# devenv.nix
{ pkgs, inputs, ... }:
let
  effectUtils = inputs.effect-utils;
  effectUtilsRoot = effectUtils.outPath;
  mkSourceCli = effectUtils.lib.mkSourceCli { inherit pkgs; };
in {
  packages = [
    (mkSourceCli { name = "genie"; entry = "packages/@overeng/genie/src/build/mod.ts"; root = effectUtilsRoot; })
    (mkSourceCli { name = "mr"; entry = "packages/@overeng/megarepo/bin/mr.ts"; root = effectUtilsRoot; })
  ];
}
```

The `root` parameter bakes in the path at Nix eval time, eliminating runtime environment variable dependencies.

### Nix Packages for CI

For CI builds and releases, use the pre-built Nix packages:

```nix
# devenv.nix (CI mode - not recommended for dev)
{ pkgs, inputs, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
in {
  packages = [
    inputs.effect-utils.packages.${system}.genie
    inputs.effect-utils.packages.${system}.megarepo
  ];
}
```

**Note:** Nix packages require hash management. When deps change, run `dt nix:hash` to update hashes. For development, prefer source-based CLIs to avoid this overhead.

## Local Overrides

Override inputs for local development with unpushed changes:

```bash
# One-time
nix build .#my-cli --override-input effect-utils path:../effect-utils

# In .envrc
use devenv --override-input effect-utils path:../effect-utils
```

## Building from Megarepo

Inside a megarepo, use direct paths for builds:

```bash
nix build --no-write-lock-file --no-link \
  "path:$DEVENV_ROOT/repos/my-repo#packages.aarch64-darwin.my-cli"
```

Use `--override-input` to reference local dependencies when needed.

## Exposing devenvModules

To share devenv task modules from your flake:

```nix
outputs = { self, ... }: {
  # Per-system outputs
  packages.x86_64-linux = { ... };

  # System-independent outputs
  devenvModules = {
    myTask = ./nix/devenv-modules/my-task.nix;
    tasks = {
      custom = import ./nix/devenv-modules/tasks/custom.nix;
    };
  };
};
```

Consumers import via:

```nix
imports = [ inputs.my-repo.devenvModules.myTask ];
```

## CI Builds

For CI, use `--frozen` or check flake outputs directly:

```bash
# Check all packages build
nix flake check

# Build specific package
nix build .#my-cli

# With megarepo (frozen mode)
mr sync --frozen
nix build "path:$DEVENV_ROOT/repos/my-repo#packages.x86_64-linux.my-cli"
```

## References

- [Nix flake inputs](https://nixos.org/manual/nix/stable/command-ref/new-cli/nix3-flake.html#flake-inputs)
- [Nix flake --override-input](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-flake#flake-references)
- [bun-cli-build](../bun-cli-build/README.md) - Building CLIs with mkBunCli
