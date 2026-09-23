{
  # Nix flake for sharing helper libraries across repos.
  #
  # We already have a devenv-based setup for local development, but repos that
  # consume effect-utils as a flake input still need a flake entry point so they
  # can import Nix helpers (for example lib.mkCliPackages) with a stable API.
  # This keeps the build logic reusable without requiring devenv in the parent.
  #
  # Prepared pnpm trees are content-addressed against the effect-utils build
  # graph, so downstream repos should make their root nixpkgs follow
  # `effect-utils/nixpkgs` instead of overriding the input the other way around.
  nixConfig = {
    extra-substituters = [ "https://overeng-effect-utils.cachix.org" ];
    extra-trusted-public-keys = [
      "overeng-effect-utils.cachix.org-1:KFmqYNF6Q7ZzVYPl2znpJYZGEolage9YNCA9res6vKc="
    ];
  };

  inputs = {
    # Track nixos-unstable: it has now advanced past the crates.io
    # importCargoLock UA fix (nixpkgs#524985), so the release-26.05 detour from
    # #703 is no longer needed and this is again the shared root authority every
    # downstream repo follows.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    tsgo.url = "github:Effect-TS/tsgo";
    weaver-flake = {
      url = "path:./nix/weaver-flake";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      tsgo,
      weaver-flake,
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
        rootPath = self.outPath;
        mkBunCli = import ./nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs; };
        cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
        mkPnpmCliSupport = import ./nix/workspace-tools/lib/mk-pnpm-cli-support.nix { inherit pkgs; };
        cliPackageRegistry = import ./nix/cli-packages.nix { inherit pkgs; };
        pnpm = import ./nix/pnpm.nix { inherit pkgs; };
        mkPnpmCli = import ./nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs pnpm; };
        megarepoSourceDepsSupport = mkPnpmCli {
          name = "megarepo-source-deps-support";
          entry = "packages/@overeng/megarepo/bin/mr.ts";
          binaryName = "mr";
          packageDir = "packages/@overeng/megarepo";
          workspaceRoot = self;
          depsBuilds = cliPackageRegistry."megarepo-source-deps-support".depsBuilds;
          generateCompletions = false;
          smokeTestArgs = [ "--version" ];
          inherit gitRev commitTs dirty;
        };
        nodePtyNative = import ./nix/node-pty-native.nix { inherit pkgs; };
        providerCliPackages = {
          vercel-cli = import ./nix/provider-clis/vercel-cli { inherit pkgs; };
          netlify-cli = import ./nix/provider-clis/netlify-cli { inherit pkgs; };
        };
        # Buck is the sole producer for shipped Rust CLIs. Nix imports the exact
        # reviewed per-tuple release assets and revalidates their descriptors,
        # payloads, native runtime contracts, and entrypoints.
        nativeProductPackages = (import ./nix/buck2-native-products { inherit pkgs; }).products;
        buck2 = import ./nix/buck2.nix { inherit pkgs; };
        mkBuckProductFromSource = import ./nix/buck2-products/from-source.nix {
          inherit pkgs buck2;
        };
        buckProductsFromSource = import ./nix/buck2-products/source-recipes.nix {
          inherit mkBuckProductFromSource;
          preparedDeps = ghCiUtils.passthru.depsBuildsByInstallRoot.root;
          preparedDepsByProduct.megarepo = megarepoSourceDepsSupport.passthru.depsBuildsByInstallRoot.root;
          # Dirty flake inputs have no commit identity. The publisher rejects dirty trees and
          # verifies this field against HEAD before mutation, so the sentinel cannot escape.
          producerCommit = self.sourceInfo.rev or "0000000000000000000000000000000000000000";
          repositoryRoot = ./.;
        };
        buck2-go = import ./nix/go.nix { inherit pkgs; };
        buck2-stage0-tools = import ./nix/buck2-stage0-tools.nix { inherit pkgs; };
        buck2-rust-toolchain-capability =
          import ./nix/workspace-tools/lib/buck2-rust-toolchain-capability.nix
            {
              inherit pkgs;
              nixpkgsRevision = nixpkgs.rev;
            };
        capabilityPackages = {
          inherit buck2 buck2-go;
          bun = pkgs.bun;
          buck2-node = pkgs.writeShellScriptBin "node" ''
            exec ${pkgs.nodejs_24 or pkgs.nodejs}/bin/node "$@"
          '';
          buck2-python-bootstrap = pkgs.writeShellScriptBin "python3" ''
            exec ${pkgs.python3}/bin/python3 "$@"
          '';
          buck2-archive-tool = buck2-stage0-tools.archive-tool;
          buck2-product = buck2-stage0-tools.product;
          buck2-coreutils = pkgs.writeShellScriptBin "readlink" ''
            exec ${pkgs.coreutils}/bin/readlink "$@"
          '';
          buck2-rust-compiler = buck2-rust-toolchain-capability.packages.rust-compiler;
          buck2-rust-rustdoc = buck2-rust-toolchain-capability.packages.rust-rustdoc;
          buck2-rust-clippy-driver = buck2-rust-toolchain-capability.packages.rust-clippy-driver;
          buck2-rust-c-compiler = buck2-rust-toolchain-capability.packages.rust-c-compiler;
          buck2-rust-cxx-compiler = buck2-rust-toolchain-capability.packages.rust-cxx-compiler;
          buck2-rust-linker = buck2-rust-toolchain-capability.packages.rust-linker;
          buck2-rust-archiver = buck2-rust-toolchain-capability.packages.rust-archiver;
          buck2-rust-dwp = buck2-rust-toolchain-capability.packages.rust-dwp;
          buck2-rust-nm = buck2-rust-toolchain-capability.packages.rust-nm;
          buck2-rust-objcopy = buck2-rust-toolchain-capability.packages.rust-objcopy;
          buck2-rust-objdump = buck2-rust-toolchain-capability.packages.rust-objdump;
          buck2-rust-ranlib = buck2-rust-toolchain-capability.packages.rust-ranlib;
          buck2-rust-strip = buck2-rust-toolchain-capability.packages.rust-strip;
          buck2-rust-shell = buck2-rust-toolchain-capability.packages.rust-shell;
          effect-tsgo = tsgo.packages.${system}.effect-tsgo;
          oxfmt = pkgs.oxfmt;
          oxlint-with-plugins = import ./nix/oxlint-with-plugins.nix {
            inherit pkgs oxlintNpm;
          };
          inherit weaver;
          semconv-model = semconv-model-capability;
        };
        buck2Rules = import ./nix/buck2-rules {
          inherit pkgs buck2;
          src = rootPath;
        };
        buck2Capabilities = import ./nix/buck2-capabilities.nix {
          inherit pkgs capabilityPackages;
          src = rootPath;
        };
        # Buck is the sole producer for admitted repository products. The
        # unadmitted gh-ci-utils CLI keeps its source-built Nix package until a
        # later authority transfer explicitly admits it.
        trackedBuck2Products = import ./nix/buck2-products {
          inherit pkgs;
          fromSourceProducts = buckProductsFromSource;
        };
        oxlintNpm = import ./nix/oxlint-npm.nix {
          inherit pkgs;
          bun = pkgs.bun;
          products = trackedBuck2Products.products;
        };
        weaver = weaver-flake.packages.${system}.weaver;
        semconv-model = weaver-flake.packages.${system}.semconv-model;
        semconv-model-capability = pkgs.runCommand "buck2-semconv-model-capability" { } ''
          mkdir -p "$out/bin" "$out/share"
          ln -s ${semconv-model} "$out/share/semconv-model"
          cat > "$out/bin/semconv-model" <<EOF
          #!${pkgs.runtimeShell}
          printf '%s\\n' "$out/share/semconv-model"
          EOF
          chmod +x "$out/bin/semconv-model"
        '';
        buck2ProductCandidates = import ./nix/workspace-tools/lib/buck2-product-candidates.nix {
          inherit
            pkgs
            gitRev
            commitTs
            dirty
            ;
          products = trackedBuck2Products.products;
          typeProofCompilerBin = "${tsgo.packages.${system}.tsgo}/bin/tsgo";
          capabilityProjection = buck2Capabilities;
        };
        ghCiUtils = import (rootPath + "/packages/@overeng/gh-ci-utils/nix/build.nix") {
          inherit
            pkgs
            gitRev
            commitTs
            dirty
            ;
          src = self;
        };
        ghCiUtilsDirty = import (rootPath + "/packages/@overeng/gh-ci-utils/nix/build.nix") {
          inherit pkgs gitRev commitTs;
          src = self;
          dirty = true;
        };
        cliPackages = buck2ProductCandidates // {
          genie = buck2ProductCandidates.genie.overrideAttrs (old: {
            passthru = (old.passthru or { }) // {
              inherit (mkPnpmCliSupport) alignAggregateManifestSpecifiersScript;
            };
          });
        };

      in
      {
        buckProducts = trackedBuck2Products;
        packages =
          cliPackages
          // providerCliPackages
          // nativeProductPackages
          // capabilityPackages
          // {
            buck2-rules = buck2Rules;
            buck2-capabilities = buck2Capabilities;
            cli-build-stamp = cliBuildStamp.package;
            gh-ci-utils = ghCiUtils;
            gh-ci-utils-dirty = ghCiUtilsDirty;
            "gh-ci-utils-pnpm-deps" = ghCiUtils.passthru.depsBuildsByInstallRoot.root;
            "megarepo-source-deps-support" = megarepoSourceDepsSupport;
            "megarepo-source-product-pnpm-deps" =
              megarepoSourceDepsSupport.passthru.depsBuildsByInstallRoot.root;
            buck-products-from-source = pkgs.linkFarm "effect-utils-buck-products-from-source" (
              pkgs.lib.mapAttrsToList (name: path: {
                name = pkgs.lib.replaceStrings [ "@" "/" ] [ "" "-" ] name;
                inherit path;
              }) buckProductsFromSource
            );
            oxlint-npm = oxlintNpm;
            node-pty-native = nodePtyNative;
          }
          // pkgs.lib.optionalAttrs (system == "x86_64-linux") { }
          // pkgs.lib.mapAttrs' (
            name: value:
            pkgs.lib.nameValuePair "buck-product-${pkgs.lib.replaceStrings [ "@" "/" ] [ "" "-" ] name}-from-source" value
          ) buckProductsFromSource;
        # Direnv helper for comparing expected CLI outputs to PATH entries.
        cliOutPaths = {
          genie = cliPackages.genie.outPath;
          ci-tools = cliPackages.ci-tools.outPath;
          gh-ci-utils = ghCiUtils.outPath;
          megarepo = cliPackages.megarepo.outPath;
          tui-stories = cliPackages.tui-stories.outPath;
          notion-cli = cliPackages.notion-cli.outPath;
          notion-md = cliPackages.notion-md.outPath;
        };
        cliOutPathsDirty = {
          gh-ci-utils = ghCiUtilsDirty.outPath;
        };

        apps = {
          update-bun-hashes = flake-utils.lib.mkApp {
            drv = import ./nix/workspace-tools/lib/update-bun-hashes.nix { inherit pkgs; };
          };
        }
        // pkgs.lib.optionalAttrs (nativeProductPackages ? otelite) {
          otelite = flake-utils.lib.mkApp {
            drv = nativeProductPackages.otelite;
            exePath = "/bin/otelite";
          };
          otel-scrape = flake-utils.lib.mkApp {
            drv = nativeProductPackages.otel-scrape;
            exePath = "/bin/otel-scrape";
          };
        };
      }
    )
    // {
      # Devenv modules for importing into other repos
      devenvModules = {
        # Lightweight native-devenv + effect-utils capture, optionally composed
        # with the full Collector/Tempo/Grafana stack.
        observability = import ./nix/devenv-modules/observability.nix;
        # OpenTelemetry observability stack (Collector + Tempo + Grafana)
        otel = import ./nix/devenv-modules/otel.nix;
        # Shared task modules (parameterized) - meant for reuse in other repos
        tasks = {
          # Simple tasks (no config needed)
          # Configure Genie through the `effectUtils.genie.*` option namespace.
          genie = ./nix/devenv-modules/tasks/shared/genie.nix;
          lint-genie = ./nix/devenv-modules/tasks/shared/lint-genie.nix;
          # Parameterized tasks (pass config)
          megarepo = import ./nix/devenv-modules/tasks/shared/megarepo.nix;
          ts = import ./nix/devenv-modules/tasks/shared/ts.nix;
          setup = import ./nix/devenv-modules/tasks/shared/setup.nix;
          check = import ./nix/devenv-modules/tasks/shared/check.nix;
          devenv-eval-input-budget = import ./nix/devenv-modules/tasks/shared/devenv-eval-input-budget.nix;
          clean = import ./nix/devenv-modules/tasks/shared/clean.nix;
          test = import ./nix/devenv-modules/tasks/shared/test.nix;
          test-playwright = import ./nix/devenv-modules/tasks/shared/test-playwright.nix;
          storybook = import ./nix/devenv-modules/tasks/shared/storybook.nix;
          netlify = import ./nix/devenv-modules/tasks/shared/netlify.nix;
          vercel = import ./nix/devenv-modules/tasks/shared/vercel.nix;
          workflow-report = import ./nix/devenv-modules/tasks/shared/workflow-report.nix;
          lint-nix = import ./nix/devenv-modules/tasks/shared/lint-nix.nix;
          lint-oxc = import ./nix/devenv-modules/tasks/shared/lint-oxc.nix;
          bun = import ./nix/devenv-modules/tasks/shared/bun.nix;
          changesets = import ./nix/devenv-modules/tasks/shared/changesets.nix;
          github-ruleset = import ./nix/devenv-modules/tasks/shared/github-ruleset.nix;
          # gh:apply-labels / gh:check-labels — reconcile .github/labels.json with live labels.
          # Parameterized by `{ repo = "owner/name"; }`; consumed like the other task modules.
          gh-labels = import ./nix/devenv-modules/gh-labels.nix;
          pnpm = import ./nix/devenv-modules/tasks/shared/pnpm.nix;
          nix-cli = import ./nix/devenv-modules/tasks/shared/nix-cli.nix;
          flake-lock-duplicates = import ./nix/devenv-modules/tasks/shared/flake-lock-duplicates.nix;
          secretspec = import ./nix/devenv-modules/tasks/shared/secretspec.nix;
          # Prevent commits on default branch and optionally enforce worktree-only workflow
          worktree-guard = import ./nix/devenv-modules/tasks/shared/worktree-guard.nix;
          # Bootstrap-safe import-closure gate; shared packaged checker runs against the importing repo root.
          bootstrap-closure = import ./nix/devenv-modules/tasks/shared/bootstrap-closure.nix;
          # Note: local/ directory contains effect-utils specific tasks (not exported)
        };
      };

      # CLI guard helpers: .mkCliGuard for single guards, .fromTasks/.stripGuards for task-driven guards
      lib.cliGuard = { pkgs }: import ./nix/devenv-modules/tasks/lib/cli-guard.nix { inherit pkgs; };

      # Builder function for external repos to create their own Bun CLIs
      lib.mkBunCli = { pkgs }: import ./nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs; };

      # Build a materialized standalone Buck root for a consumer checkout.
      lib.mkConsumerBuckRoot = args: import ./nix/buck2-products/consumer-root.nix args;

      # Rebuild a declared Buck product from source inside the Nix sandbox.
      lib.mkBuckProductFromSource =
        {
          pkgs,
          buck2 ? self.packages.${pkgs.stdenv.hostPlatform.system}.buck2,
        }:
        import ./nix/buck2-products/from-source.nix { inherit pkgs buck2; };

      # Verify and import a published Buck artifact into a normal Nix output for
      # wrapping and later Home Manager/system activation.
      lib.mkBuck2ArtifactImport =
        { pkgs }: import ./nix/workspace-tools/lib/buck2-artifact-import.nix { inherit pkgs; };

      # Verify and import one tracked Buck JavaScript product (descriptor plus
      # content-addressed module bytes) into a wrappable Nix output.
      lib.mkBuck2JavaScriptProductImport =
        { pkgs }: import ./nix/workspace-tools/lib/javascript-product-import.nix { inherit pkgs; };

      # Wrap this effect-utils revision's tracked Buck JavaScript products into
      # candidate packages. Callers can replace `products` for an explicit
      # manifest experiment; normal consumers inherit this revision's manifest.
      # Usage: effectUtils.lib.mkBuck2ProductCandidates { inherit pkgs; }
      lib.mkBuck2ProductCandidates =
        args:
        import ./nix/workspace-tools/lib/buck2-product-candidates.nix (
          {
            products = self.buckProducts.${args.pkgs.stdenv.hostPlatform.system}.products;
            typeProofCompilerBin = "${tsgo.packages.${args.pkgs.stdenv.hostPlatform.system}.tsgo}/bin/tsgo";
          }
          // args
        );

      # Shell helper for runtime CLI build stamps.
      lib.cliBuildStamp =
        { pkgs }: import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };

      # Build Grafonnet dashboards against the shared OTEL dashboard library.
      # Returns a linkFarm (Nix store path) containing compiled JSON files.
      lib.buildOtelDashboards =
        {
          pkgs,
          src,
          dashboardNames,
        }:
        import ./nix/devenv-modules/otel/build-dashboards.nix { inherit pkgs src dashboardNames; };

      # Standalone otel-span CLI (run + emit subcommands).
      # Can be added to devenv packages without importing the full OTEL module.
      lib.mkOtelSpan = { pkgs }: import ./nix/devenv-modules/otel/otel-span.nix { inherit pkgs; };

      # Convenience helper for bundling the common genie/megarepo CLIs from
      # this effect-utils revision's tracked Buck products. An explicit
      # `products` argument remains available for manifest experiments.
      lib.mkCliPackages =
        args:
        import ./nix/workspace-tools/lib/mk-cli-packages.nix (
          {
            products = self.buckProducts.${args.pkgs.stdenv.hostPlatform.system}.products;
            typeProofCompilerBin = "${tsgo.packages.${args.pkgs.stdenv.hostPlatform.system}.tsgo}/bin/tsgo";
          }
          // args
        );

      # npm oxlint with NAPI bindings plus the two tracked immutable
      # @overeng/oxc-config JavaScript plugin products.
      # Usage: effectUtils.lib.mkOxlintNpm { inherit pkgs; bun = pkgs.bun; }
      lib.mkOxlintNpm =
        {
          pkgs,
          bun,
          products ? self.buckProducts.${pkgs.stdenv.hostPlatform.system}.products,
        }:
        import ./nix/oxlint-npm.nix { inherit pkgs bun products; };

      # oxlint wrapper that substitutes the overeng and @stylexjs configured
      # entries with their separate tracked module paths. Projects without
      # either namespace pass through to plain oxlint-npm.
      # Usage: effectUtils.lib.mkOxlintWithPlugins { inherit pkgs; oxlintNpm = effectUtils.packages.\${system}.oxlint-npm; }
      lib.mkOxlintWithPlugins =
        {
          pkgs,
          oxlintNpm,
        }:
        import ./nix/oxlint-with-plugins.nix { inherit pkgs oxlintNpm; };

      # Pinned pnpm for the entire megarepo ecosystem.
      # Usage: effectUtils.lib.mkPnpm { inherit pkgs; }
      lib.mkPnpm = { pkgs }: import ./nix/pnpm.nix { inherit pkgs; };

      # For consuming CLIs from other repos, use:
      #   effectUtils.packages.${system}.genie
      #   effectUtils.packages.${system}.ci-tools
      #   effectUtils.packages.${system}.megarepo
      # See the stack-level Nix/devenv CLI distribution policy docs.
    };
}
