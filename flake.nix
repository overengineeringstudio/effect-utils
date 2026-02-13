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

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      ...
    }:
    let
      gitRev =
        self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
      # lastModified is the git commit timestamp (Unix seconds)
      commitTs = self.sourceInfo.lastModified or 0;
      dirty = self.sourceInfo ? dirtyShortRev;
    in
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        mkBunCli = import ./nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs; };
        cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
        rootPath = self.outPath;
        cliPackages = {
          genie = import (rootPath + "/packages/@overeng/genie/nix/build.nix") {
            inherit
              pkgs
              gitRev
              commitTs
              dirty
              ;
            src = self;
          };
          megarepo = import (rootPath + "/packages/@overeng/megarepo/nix/build.nix") {
            inherit
              pkgs
              gitRev
              commitTs
              dirty
              ;
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
          beads = import ./nix/beads.nix { inherit pkgs; };
          cli-build-stamp = cliBuildStamp.package;
          genie-dirty = cliPackagesDirty.genie;
          megarepo-dirty = cliPackagesDirty.megarepo;
          # npm oxlint with NAPI bindings + pre-bundled @overeng/oxc-config plugin
          oxlint-npm = import ./nix/oxlint-npm.nix {
            inherit pkgs;
            bun = pkgs.bun;
            src = self;
          };
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
    )
    // {
      # Devenv modules for importing into other repos
      devenvModules = {
        # `dt` command wrapper for devenv tasks with shell completions
        dt = ./nix/devenv-modules/dt.nix;
        # OpenTelemetry observability stack (Collector + Tempo + Grafana)
        otel = import ./nix/devenv-modules/otel.nix;
        # Shared task modules (parameterized) - meant for reuse in other repos
        tasks = {
          # Simple tasks (no config needed)
          genie = ./nix/devenv-modules/tasks/shared/genie.nix;
          lint-genie = ./nix/devenv-modules/tasks/shared/lint-genie.nix;
          # Parameterized tasks (pass config)
          megarepo = import ./nix/devenv-modules/tasks/shared/megarepo.nix;
          ts = import ./nix/devenv-modules/tasks/shared/ts.nix;
          setup = import ./nix/devenv-modules/tasks/shared/setup.nix;
          check = import ./nix/devenv-modules/tasks/shared/check.nix;
          clean = import ./nix/devenv-modules/tasks/shared/clean.nix;
          test = import ./nix/devenv-modules/tasks/shared/test.nix;
          test-playwright = import ./nix/devenv-modules/tasks/shared/test-playwright.nix;
          storybook = import ./nix/devenv-modules/tasks/shared/storybook.nix;
          netlify = import ./nix/devenv-modules/tasks/shared/netlify.nix;
          lint-oxc = import ./nix/devenv-modules/tasks/shared/lint-oxc.nix;
          bun = import ./nix/devenv-modules/tasks/shared/bun.nix;
          pnpm = import ./nix/devenv-modules/tasks/shared/pnpm.nix;
          nix-cli = import ./nix/devenv-modules/tasks/shared/nix-cli.nix;
          beads = import ./nix/devenv-modules/tasks/shared/beads.nix;
          # Workaround for cachix/devenv#2455 - ensures hooks are actually installed
          git-hooks-fix = ./nix/devenv-modules/tasks/shared/git-hooks-fix.nix;
          # Prevent commits on default branch and optionally enforce worktree-only workflow
          worktree-guard = import ./nix/devenv-modules/tasks/shared/worktree-guard.nix;
          # Note: local/ directory contains effect-utils specific tasks (not exported)
        };
      };

      # Builder function for external repos to create their own Bun CLIs
      lib.mkBunCli = { pkgs }: import ./nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs; };

      # Shell helper for runtime CLI build stamps.
      lib.cliBuildStamp =
        { pkgs }: import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };

      # Build Grafonnet dashboards against the shared OTEL dashboard library.
      # Returns a linkFarm (Nix store path) containing compiled JSON files.
      lib.buildOtelDashboards =
        { pkgs, src, dashboardNames }:
        import ./nix/devenv-modules/otel/build-dashboards.nix { inherit pkgs src dashboardNames; };

      # Standalone otel-span CLI (run + emit subcommands).
      # Can be added to devenv packages without importing the full OTEL module.
      lib.mkOtelSpan = { pkgs }: import ./nix/devenv-modules/otel/otel-span.nix { inherit pkgs; };

      # Convenience helper for bundling the common genie/megarepo CLIs.
      # Use this for releases/CI where hermetic Nix builds are needed.
      lib.mkCliPackages = import ./nix/workspace-tools/lib/mk-cli-packages.nix;

      # npm oxlint with NAPI bindings for JavaScript plugin support.
      # When `src` is provided (the effect-utils source), the @overeng/oxc-config
      # plugin is bundled alongside and exposed via passthru.pluginPath.
      # Usage: effectUtils.lib.mkOxlintNpm { inherit pkgs; bun = pkgs.bun; src = inputs.effect-utils; }
      lib.mkOxlintNpm =
        {
          pkgs,
          bun,
          src ? null,
        }:
        import ./nix/oxlint-npm.nix { inherit pkgs bun src; };

      # Beads (bd) pre-built binary package from GitHub releases.
      # Usage: effectUtils.lib.mkBeads { inherit pkgs; }
      lib.mkBeads = { pkgs }: import ./nix/beads.nix { inherit pkgs; };

      # Note: mkSourceCli is internal-only (not exported).
      # For consuming CLIs from other repos, use:
      #   effectUtils.packages.${system}.genie
      #   effectUtils.packages.${system}.megarepo
      # See: context/nix-devenv/cli-patterns.md
    };
}
