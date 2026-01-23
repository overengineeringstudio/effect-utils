{
  description = "mk-bun-cli peer repo fixture";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    effect-utils = {
      url = "path:../effect-utils";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, flake-utils, effect-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        mkBunCli = import "${effect-utils}/nix/workspace-tools/lib/mk-bun-cli.nix" {
          inherit pkgs;
        };

        appCli = mkBunCli {
          name = "app-cli";
          entry = "src/cli.ts";
          packageDir = ".";
          workspaceRoot = self;
          bunDepsHash = "sha256-bgayVjxWMiacjo3XyHT663lCj2rLcUvinkbD5nbo9r0=";
          typecheck = false;
        };
      in
      {
        packages = {
          app-cli = appCli;
          default = appCli;
        };
      });
}
