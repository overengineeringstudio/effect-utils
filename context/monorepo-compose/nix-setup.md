# Nix Setup

## devenv (recommended)

The main README uses devenv with GitHub URLs. This is the simplest approach - devenv fetches packages directly from GitHub.

## Pure Nix Flakes

For local submodule development without devenv, use pure flakes with `inputs.self.submodules = true`:

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    effect-utils = {
      url = "path:./submodules/effect-utils";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.nixpkgsUnstable.follows = "nixpkgsUnstable";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  # Required for Nix to see files inside git submodules
  inputs.self.submodules = true;

  outputs = { self, nixpkgs, nixpkgsUnstable, flake-utils, effect-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ effect-utils.overlays.pnpmGuard ];
        };
        pkgsUnstable = import nixpkgsUnstable { inherit system; };
        cliPackages = effect-utils.lib.mkCliPackages {
          inherit pkgs pkgsUnstable;
          src = effect-utils.outPath;
        };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.pnpm
            pkgs.nodejs_24
            pkgs.bun
            cliPackages.genie
            cliPackages.pnpm-compose
          ];

          shellHook = ''
            export WORKSPACE_ROOT="$PWD"
            export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
          '';
        };
      });
}
```

With `.envrc`:

```bash
export WORKSPACE_ROOT=$(pwd)
use flake
```

## pnpm Guard Overlay

The `effect-utils.overlays.pnpmGuard` overlay wraps `pnpm` to block install commands inside submodules. This prevents accidentally corrupting the workspace by running `pnpm install` in a submodule directory.

## References

- [devenv inputs docs](https://devenv.sh/inputs/)
