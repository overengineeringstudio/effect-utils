{
  # Nix flake for sharing helper libraries across repos.
  #
  # We already have a devenv-based setup for local development, but repos that
  # consume effect-utils as a flake input still need a flake entry point so they
  # can import Nix helpers (for example lib.mkCliPackages) with a stable API.
  # This keeps the build logic reusable without requiring devenv in the parent.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-25.11";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, nixpkgsUnstable, flake-utils, ... }:
    let
      gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
    in
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        pkgsUnstable = import nixpkgsUnstable { inherit system; };
        mkBunCli = import ./nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };
        cliBuildStamp = import ./nix/cli-build-stamp.nix { inherit pkgs; };
        rootPath = self.outPath;
      in
      {
        packages = {
          cli-build-stamp = cliBuildStamp.package;
          genie = import (rootPath + "/packages/@overeng/genie/nix/build.nix") {
            inherit pkgs pkgsUnstable gitRev;
            src = self;
          };
          dotdot = import (rootPath + "/packages/@overeng/dotdot/nix/build.nix") {
            inherit pkgs pkgsUnstable gitRev;
            src = self;
          };
          mono = import ./scripts/nix/build.nix {
            inherit pkgs pkgsUnstable mkBunCli;
            src = self;
            inherit gitRev;
          };
        };

        apps.update-bun-hashes = flake-utils.lib.mkApp {
          drv = import ./nix/update-bun-hashes.nix { inherit pkgs; };
        };
      }
    ) // {
      # Builder function for external repos to create their own Bun CLIs
      lib.mkBunCli = { pkgs, pkgsUnstable }:
        import ./nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };

      # Shell helper for runtime CLI build stamps.
      lib.cliBuildStamp = { pkgs, workspaceRoot ? null }:
        import ./nix/cli-build-stamp.nix { inherit pkgs workspaceRoot; };

      # Convenience helper for bundling the common genie/dotdot CLIs.
      lib.mkCliPackages = {
        pkgs,
        pkgsUnstable,
        gitRev ? "unknown",
        workspaceRoot ? ./.,
      }:
        let
          workspaceRootPath =
            if builtins.isAttrs workspaceRoot && builtins.hasAttr "outPath" workspaceRoot
            then workspaceRoot.outPath
            else workspaceRoot;
        in
        {
          genie = import (workspaceRootPath + "/packages/@overeng/genie/nix/build.nix") {
            inherit pkgs pkgsUnstable gitRev;
            src = workspaceRoot;
          };
          dotdot = import (workspaceRootPath + "/packages/@overeng/dotdot/nix/build.nix") {
            inherit pkgs pkgsUnstable gitRev;
            src = workspaceRoot;
          };
        };
    };
}
