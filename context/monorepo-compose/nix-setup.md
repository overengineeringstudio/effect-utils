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
    flake-utils.url = "github:numtide/flake-utils";
    genie = {
      url = "path:./submodules/effect-utils/packages/@overeng/genie";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
    pnpm-compose = {
      url = "path:./submodules/effect-utils/packages/@overeng/pnpm-compose";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  # Required for Nix to see files inside git submodules
  inputs.self.submodules = true;

  outputs = { self, nixpkgs, flake-utils, genie, pnpm-compose, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ pnpm-compose.overlays.pnpmGuard ];
        };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.pnpm
            pkgs.nodejs_24
            pkgs.bun
            genie.packages.${system}.default
            pnpm-compose.packages.${system}.default
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

The `pnpm-compose.overlays.pnpmGuard` overlay wraps `pnpm` to block install commands inside submodules. This prevents accidentally corrupting the workspace by running `pnpm install` in a submodule directory.

## References

- [devenv inputs docs](https://devenv.sh/inputs/)
