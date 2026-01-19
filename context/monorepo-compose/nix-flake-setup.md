# Pure Nix Flake Setup

Use stable GitHub URLs in `flake.nix` and override inputs locally via `.envrc`.

## flake.nix

```nix
{
  description = "My project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-25.11";
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
        cliBuildStamp = effect-utils.lib.cliBuildStamp { inherit pkgs; };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgsUnstable.bun
            pkgsUnstable.nodejs_24
            cliPackages.genie
            cliPackages.dotdot
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

Override effect-utils to use local sibling repo:

```bash
if command -v nix-shell &> /dev/null
then
  export WORKSPACE_ROOT=$(pwd)
  use flake . --override-input effect-utils path:../effect-utils
  # Load effect-utils CLI auto-rebuild helper (fresh CLIs + dirty changes; see ./devenv-setup.md).
  source "$(nix eval --raw --no-write-lock-file "$WORKSPACE_ROOT/../effect-utils#direnv.peerEnvrcEffectUtils")"
fi
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

## CLI build stamp

The `cliBuildStamp` helper exports `NIX_CLI_BUILD_STAMP` so local CLI runs can
include a `<git-sha>+<YYYY-MM-DDTHH:MM:SS+/-HH:MM>[-dirty]` suffix (or append it to
injected versions). It reads `WORKSPACE_ROOT` or `CLI_BUILD_STAMP_ROOT`.

## Input Follows

Deduplicate shared inputs using `follows`:

```nix
inputs = {
  nixpkgs.url = "github:NixOS/nixpkgs/release-25.11";
  effect-utils = {
    url = "github:overengineeringstudio/effect-utils";
    inputs.nixpkgs.follows = "nixpkgs";
    inputs.nixpkgsUnstable.follows = "nixpkgsUnstable";
    inputs.flake-utils.follows = "flake-utils";
  };
};
```

## Test Repo

See `tests/mk-bun-cli` in effect-utils for fixture repos and the runner that
exercise flakes, devenv, and peer-repo composition.

## References

- [nix flake inputs](https://nixos.org/manual/nix/stable/command-ref/new-cli/nix3-flake.html#flake-inputs)
- [nix flake --override-input](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-flake#flake-references)
