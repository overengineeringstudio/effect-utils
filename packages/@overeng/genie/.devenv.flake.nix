# devenv looks for this file instead of flake.nix (devenv#1137)
{
  description = "Genie CLI for generating config files from .genie.ts templates";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-25.11";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, nixpkgsUnstable, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system: {
      packages.default = import ./nix/build.nix {
        pkgs = import nixpkgs { inherit system; };
        pkgsUnstable = import nixpkgsUnstable { inherit system; };
        src = ../../..;
      };
    });
}
