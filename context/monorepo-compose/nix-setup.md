# Nix Setup

## devenv (recommended)

The main README uses devenv with GitHub URLs. This is the simplest approach - devenv fetches packages directly from GitHub.

## Pure Nix Flakes

For local development without devenv, use pure flakes:

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    effect-utils = {
      url = "git+file:../effect-utils";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.nixpkgsUnstable.follows = "nixpkgsUnstable";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, nixpkgsUnstable, flake-utils, effect-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        pkgsUnstable = import nixpkgsUnstable { inherit system; };
        cliPackages = effect-utils.lib.mkCliPackages {
          inherit pkgs pkgsUnstable;
        };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.bun
            pkgs.nodejs_24
            cliPackages.genie
            cliPackages.dotdot
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

## Nix Path Dependencies

When using nix flakes with sibling repos, use `git+file:` (not `path:`):

```nix
inputs = {
  sibling-repo.url = "git+file:../sibling-repo";
  # Deduplicate shared inputs
  other-repo.inputs.sibling-repo.follows = "sibling-repo";
};
```

**Important:** `path:` inputs cannot escape git repo boundaries. Always use `git+file:` for cross-repo references.

## References

- [devenv inputs docs](https://devenv.sh/inputs/)
- [nix flake inputs docs](https://nixos.org/manual/nix/stable/command-ref/new-cli/nix3-flake.html#flake-inputs)
