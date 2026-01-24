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

## Exposing Packages to Devenv

Devenv accesses flake packages via inputs:

```nix
# devenv.nix
{ pkgs, inputs, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
in {
  packages = [
    inputs.self.packages.${system}.my-cli
    inputs.effect-utils.packages.${system}.genie
  ];
}
```

## Local Overrides

Override inputs for local development with unpushed changes:

```bash
# One-time
nix build .#my-cli --override-input effect-utils path:../effect-utils

# In .envrc
use devenv --override-input effect-utils path:../effect-utils
```

## Building from Megarepo

Inside a megarepo, use the generated workspace path for faster builds:

```bash
nix build --no-write-lock-file --no-link \
  "path:$MEGAREPO_NIX_WORKSPACE#packages.aarch64-darwin.my-repo.my-cli"
```

The megarepo workspace avoids `path:.` hashing of large trees (node_modules, etc.).

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
nix build "path:$MEGAREPO_NIX_WORKSPACE#packages.x86_64-linux.my-repo.my-cli"
```

## References

- [Nix flake inputs](https://nixos.org/manual/nix/stable/command-ref/new-cli/nix3-flake.html#flake-inputs)
- [Nix flake --override-input](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-flake#flake-references)
- [bun-cli-build](../bun-cli-build/README.md) - Building CLIs with mkBunCli
