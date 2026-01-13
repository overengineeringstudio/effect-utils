# devenv looks for this file instead of flake.nix (devenv#1137)
{
  description = "Mono CLI for managing the effect-utils monorepo";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-25.11";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    workspace = {
      url = "github:overengineeringstudio/effect-utils";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, nixpkgsUnstable, flake-utils, workspace, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
        pkgs = import nixpkgs { inherit system; };
        pkgsUnstable = import nixpkgsUnstable { inherit system; };
        workspacePath =
          if builtins.isPath workspace
          then workspace
          else if builtins.isAttrs workspace && builtins.hasAttr "outPath" workspace
          then workspace.outPath
          else builtins.toPath workspace;
        mkBunCli = import (workspacePath + "/nix/mk-bun-cli.nix") {
          inherit pkgs pkgsUnstable;
        };
      in
      {
        packages.default = import ./nix/build.nix {
          inherit pkgs pkgsUnstable mkBunCli;
          src = workspacePath;
          inherit gitRev;
        };
      });
}
