{
  description = "Genie CLI for generating config files from .genie.ts templates";

  inputs = {
    workspace.url = "github:overengineeringstudio/effect-utils?dir=nix/workspace-flake";
    nixpkgs.follows = "workspace/nixpkgs";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
      in
      {
        packages.default = import ./nix/build.nix {
          pkgs = import nixpkgs { inherit system; };
          pkgsUnstable = import nixpkgs { inherit system; };
          src = ../../..;  # effect-utils root (for bun.lock, package.json)
          inherit gitRev;
        };
      });
}
