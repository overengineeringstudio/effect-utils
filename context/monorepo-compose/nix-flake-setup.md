# Pure Nix Flake Setup

Use stable GitHub URLs in `flake.nix` and override inputs locally via `.envrc`.

## flake.nix

```nix
{
  description = "My project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    effect-utils = {
      url = "github:overengineeringstudio/effect-utils";
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

## .envrc

Override effect-utils to use local sibling repo:

```bash
export WORKSPACE_ROOT=$(pwd)
use flake . --override-input effect-utils path:../effect-utils
```

## .gitignore

```
.direnv/
result
```

## How It Works

- `flake.nix` uses stable GitHub URLs (works in CI without changes)
- `.envrc` overrides effect-utils to the local sibling repo via `--override-input`
- `path:../effect-utils` resolves relative to the flake location
- No deprecation warnings

## Input Follows

Deduplicate shared inputs using `follows`:

```nix
inputs = {
  nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  effect-utils = {
    url = "github:overengineeringstudio/effect-utils";
    inputs.nixpkgs.follows = "nixpkgs";
    inputs.nixpkgsUnstable.follows = "nixpkgsUnstable";
    inputs.flake-utils.follows = "flake-utils";
  };
};
```

## Test Repo

See `test-nix-flake/` in the dotdot workspace for a working example.

## References

- [nix flake inputs](https://nixos.org/manual/nix/stable/command-ref/new-cli/nix3-flake.html#flake-inputs)
- [nix flake --override-input](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-flake#flake-references)
