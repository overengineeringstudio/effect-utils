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
        mkBunCli = import ./nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };
        cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
        rootPath = self.outPath;
        cliPackages = {
          genie = import (rootPath + "/packages/@overeng/genie/nix/build.nix") {
            inherit pkgs pkgsUnstable gitRev;
            src = self;
          };
          dotdot = import (rootPath + "/packages/@overeng/dotdot/nix/build.nix") {
            inherit pkgs pkgsUnstable gitRev;
            src = self;
          };
          megarepo = import (rootPath + "/packages/@overeng/megarepo/nix/build.nix") {
            inherit pkgs pkgsUnstable gitRev;
            src = self;
          };
          mono = import ./scripts/nix/build.nix {
            inherit pkgs pkgsUnstable mkBunCli;
            src = self;
            inherit gitRev;
            dirty = false;
          };
        };
        cliPackagesDirty = {
          genie = import (rootPath + "/packages/@overeng/genie/nix/build.nix") {
            inherit pkgs pkgsUnstable gitRev;
            src = self;
            dirty = true;
          };
          dotdot = import (rootPath + "/packages/@overeng/dotdot/nix/build.nix") {
            inherit pkgs pkgsUnstable gitRev;
            src = self;
            dirty = true;
          };
          megarepo = import (rootPath + "/packages/@overeng/megarepo/nix/build.nix") {
            inherit pkgs pkgsUnstable gitRev;
            src = self;
            dirty = true;
          };
          mono = import ./scripts/nix/build.nix {
            inherit pkgs pkgsUnstable mkBunCli;
            src = self;
            inherit gitRev;
            dirty = true;
          };
        };
      in
      {
        packages = cliPackages // {
          cli-build-stamp = cliBuildStamp.package;
          genie-dirty = cliPackagesDirty.genie;
          dotdot-dirty = cliPackagesDirty.dotdot;
          megarepo-dirty = cliPackagesDirty.megarepo;
          mono-dirty = cliPackagesDirty.mono;
        };

        # Direnv helper for comparing expected CLI outputs to PATH entries.
        cliOutPaths = {
          genie = cliPackages.genie.outPath;
          dotdot = cliPackages.dotdot.outPath;
          megarepo = cliPackages.megarepo.outPath;
          mono = cliPackages.mono.outPath;
        };
        cliOutPathsDirty = {
          genie = cliPackagesDirty.genie.outPath;
          dotdot = cliPackagesDirty.dotdot.outPath;
          megarepo = cliPackagesDirty.megarepo.outPath;
          mono = cliPackagesDirty.mono.outPath;
        };

        apps.update-bun-hashes = flake-utils.lib.mkApp {
          drv = import ./nix/workspace-tools/lib/update-bun-hashes.nix { inherit pkgs; };
        };
      }
    ) // {
      # Devenv modules for importing into other repos
      devenvModules = {
        # `dt` command wrapper for devenv tasks with shell completions
        dt = ./nix/devenv-modules/dt.nix;
      };

      # Direnv helper script (eval-time store path; no build required).
      direnv.autoRebuildClis = import ./nix/workspace-tools/env/direnv/auto-rebuild-clis.nix;
      direnv.peerEnvrc = import ./nix/workspace-tools/env/direnv/peer-envrc.nix;
      direnv.peerEnvrcEffectUtils = import ./nix/workspace-tools/env/direnv/peer-envrc-effect-utils.nix;
      direnv.effectUtilsEnvrc = import ./nix/workspace-tools/env/direnv/effect-utils-envrc.nix;

      # Builder function for external repos to create their own Bun CLIs
      lib.mkBunCli = { pkgs, pkgsUnstable }:
        import ./nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };

      # Shell helper for runtime CLI build stamps.
      lib.cliBuildStamp = { pkgs, workspaceRoot ? null }:
        import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs workspaceRoot; };

      # Convenience helper for bundling the common genie/dotdot CLIs.
      lib.mkCliPackages = {
        pkgs,
        pkgsUnstable,
        gitRev ? "unknown",
        workspaceRoot ? ./.,
        dirty ? false,
      }:
        let
          workspaceRootPath =
            if builtins.isAttrs workspaceRoot && builtins.hasAttr "outPath" workspaceRoot
            then workspaceRoot.outPath
            else workspaceRoot;
        in
        {
          genie = import (workspaceRootPath + "/packages/@overeng/genie/nix/build.nix") {
            inherit pkgs pkgsUnstable gitRev dirty;
            src = workspaceRoot;
          };
          dotdot = import (workspaceRootPath + "/packages/@overeng/dotdot/nix/build.nix") {
            inherit pkgs pkgsUnstable gitRev dirty;
            src = workspaceRoot;
          };
        };
    };
}
