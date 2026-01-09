# Shared flake outputs - imported by both flake.nix and .devenv.flake.nix
#
# WHY TWO ENTRY POINTS?
#
# Standard Nix flakes use `flake.nix`, but devenv's CLI has a quirk where it
# looks for `.devenv.flake.nix` in flake inputs instead of `flake.nix`.
# See: https://github.com/cachix/devenv/issues/1137
#
# Without `.devenv.flake.nix`, devenv fails with:
#   "error: '.../.devenv.flake.nix' does not exist"
#
# This shared outputs file allows both entry points to work:
# - `nix build/develop` uses flake.nix (standard Nix workflow)
# - `devenv shell` uses .devenv.flake.nix (devenv CLI workflow)
#
# Workaround alternative: use `flake: false` in devenv.yaml, but then you
# lose flake-based caching and must build inline in devenv.nix.

{ nixpkgs, nixpkgsUnstable, flake-utils, ... }:
flake-utils.lib.eachDefaultSystem (system: {
  packages.default = import ./build.nix {
    pkgs = import nixpkgs { inherit system; };
    pkgsUnstable = import nixpkgsUnstable { inherit system; };
    src = ../../../..;  # effect-utils root (for bun.lock, package.json)
  };
})
