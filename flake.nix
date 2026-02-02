{
  # Nix flake for sharing helper libraries across repos.
  #
  # We already have a devenv-based setup for local development, but repos that
  # consume effect-utils as a flake input still need a flake entry point so they
  # can import Nix helpers (for example lib.mkCliPackages) with a stable API.
  # This keeps the build logic reusable without requiring devenv in the parent.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    let
      gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
      # lastModified is the git commit timestamp (Unix seconds)
      commitTs = self.sourceInfo.lastModified or 0;
      dirty = self.sourceInfo ? dirtyShortRev;
    in
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        mkBunCli = import ./nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs; };
        cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
        rootPath = self.outPath;
        cliPackages = {
          genie = import (rootPath + "/packages/@overeng/genie/nix/build.nix") {
            inherit pkgs gitRev commitTs dirty;
            src = self;
          };
          megarepo = import (rootPath + "/packages/@overeng/megarepo/nix/build.nix") {
            inherit pkgs gitRev commitTs dirty;
            src = self;
          };
        };
        cliPackagesDirty = {
          genie = import (rootPath + "/packages/@overeng/genie/nix/build.nix") {
            inherit pkgs gitRev commitTs;
            src = self;
            dirty = true;
          };
          megarepo = import (rootPath + "/packages/@overeng/megarepo/nix/build.nix") {
            inherit pkgs gitRev commitTs;
            src = self;
            dirty = true;
          };
        };
      in
      {
        packages = cliPackages // {
          cli-build-stamp = cliBuildStamp.package;
          genie-dirty = cliPackagesDirty.genie;
          megarepo-dirty = cliPackagesDirty.megarepo;
        };

        # Direnv helper for comparing expected CLI outputs to PATH entries.
        cliOutPaths = {
          genie = cliPackages.genie.outPath;
          megarepo = cliPackages.megarepo.outPath;
        };
        cliOutPathsDirty = {
          genie = cliPackagesDirty.genie.outPath;
          megarepo = cliPackagesDirty.megarepo.outPath;
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
        # Shared task modules (parameterized) - meant for reuse in other repos
        tasks = {
          # Simple tasks (no config needed)
          genie = ./nix/devenv-modules/tasks/shared/genie.nix;
          lint-genie = ./nix/devenv-modules/tasks/shared/lint-genie.nix;
          megarepo = ./nix/devenv-modules/tasks/shared/megarepo.nix;
          # Parameterized tasks (pass config)
          ts = import ./nix/devenv-modules/tasks/shared/ts.nix;
          setup = import ./nix/devenv-modules/tasks/shared/setup.nix;
          check = import ./nix/devenv-modules/tasks/shared/check.nix;
          clean = import ./nix/devenv-modules/tasks/shared/clean.nix;
          test = import ./nix/devenv-modules/tasks/shared/test.nix;
          test-playwright = import ./nix/devenv-modules/tasks/shared/test-playwright.nix;
          storybook = import ./nix/devenv-modules/tasks/shared/storybook.nix;
          lint-oxc = import ./nix/devenv-modules/tasks/shared/lint-oxc.nix;
          bun = import ./nix/devenv-modules/tasks/shared/bun.nix;
          pnpm = import ./nix/devenv-modules/tasks/shared/pnpm.nix;
          nix-cli = import ./nix/devenv-modules/tasks/shared/nix-cli.nix;
          # Note: local/ directory contains effect-utils specific tasks (not exported)
        };
      };

      # Builder function for external repos to create their own Bun CLIs
      lib.mkBunCli = { pkgs }:
        import ./nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs; };

      # Shell helper for runtime CLI build stamps.
      lib.cliBuildStamp = { pkgs }:
        import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };

      # Convenience helper for bundling the common genie/megarepo CLIs.
      # Use this for releases/CI where hermetic Nix builds are needed.
      lib.mkCliPackages = import ./nix/workspace-tools/lib/mk-cli-packages.nix;

      # npm oxlint with NAPI bindings for JavaScript plugin support.
      # Usage: effectUtils.lib.mkOxlintNpm { inherit pkgs; bun = pkgs.bun; }
      lib.mkOxlintNpm = { pkgs, bun }:
        import ./nix/oxlint-npm.nix { inherit pkgs bun; };

      # Note: mkSourceCli is internal-only (not exported).
      # For consuming genie/megarepo from other repos, use:
      #   effectUtils.packages.${system}.genie
      #   effectUtils.packages.${system}.megarepo
      # See: context/nix-devenv/cli-patterns.md
    };
}
