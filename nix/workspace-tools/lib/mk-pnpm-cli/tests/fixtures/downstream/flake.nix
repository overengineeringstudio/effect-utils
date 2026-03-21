{
  description = "mk-pnpm-cli downstream flake-input fixture";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    effect-utils = {
      url = "path:../effect-utils";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { nixpkgs, flake-utils, effect-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        effectUtilsPackages = effect-utils.packages.${system};
      in
      {
        packages = {
          genie = effectUtilsPackages.genie;
          megarepo = effectUtilsPackages.megarepo;
          oxlint-npm = effectUtilsPackages.oxlint-npm;
          default = effectUtilsPackages.megarepo;
        };
      }
    );
}
