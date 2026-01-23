# Pure Nix Flake Setup

Use stable GitHub URLs in `flake.nix`. Each repo pins its own `nixpkgs`;
alignment across repos is optional. Override inputs locally only when you need
unpushed changes.

## flake.nix

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
        cliPackages = effect-utils.lib.mkCliPackages {
          inherit pkgs;
        };
        cliBuildStamp = effect-utils.lib.cliBuildStamp { inherit pkgs; };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.bun
            pkgs.nodejs_24
            cliPackages.genie
            cliBuildStamp.package
          ];

          shellHook = ''
            export WORKSPACE_ROOT="$PWD"
            ${cliBuildStamp.shellHook}
          '';
        };
      });
}
```

## .envrc

```bash
source_env_if_exists ./.envrc.generated.megarepo
use flake
```

## .gitignore

```
.direnv/
result
```

## Local Overrides (Unpushed Changes)

To use a local checkout instead of GitHub:

```bash
use flake . --override-input effect-utils path:../effect-utils
```

Run `direnv allow` after updating `.envrc`.

In a megarepo, prefer building from the local workspace path:

```bash
nix build "path:$MEGAREPO_NIX_WORKSPACE#packages.<system>.my-repo.<target>"
```

## Input Follows

Deduplicate shared inputs using `follows`:

```nix
inputs = {
  nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  effect-utils = {
    url = "github:overengineeringstudio/effect-utils";
    inputs.nixpkgs.follows = "nixpkgs";
    inputs.flake-utils.follows = "flake-utils";
  };
};
```

## References

- [nix flake inputs](https://nixos.org/manual/nix/stable/command-ref/new-cli/nix3-flake.html#flake-inputs)
- [nix flake --override-input](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-flake#flake-references)
