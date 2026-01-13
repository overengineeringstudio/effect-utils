{
  description = "mk-bun-cli peer repo fixture";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    effect-utils = {
      url = "path:../effect-utils";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.nixpkgsUnstable.follows = "nixpkgsUnstable";
      inputs.flake-utils.follows = "flake-utils";
    };
    workspace = {
      url = "path:..";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, nixpkgsUnstable, flake-utils, effect-utils, workspace, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        pkgsUnstable = import nixpkgsUnstable { inherit system; };
        mkBunCli = import "${effect-utils}/nix/mk-bun-cli.nix" { inherit pkgs pkgsUnstable; };

        appCli = mkBunCli {
          name = "app-cli";
          entry = "app/src/cli.ts";
          packageDir = "app";
          workspaceRoot = workspace;
          bunDepsHash = pkgs.lib.fakeHash;
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
