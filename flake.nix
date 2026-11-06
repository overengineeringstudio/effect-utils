rec {
  # Nix flake for sharing helper libraries across repos.
  #
  # We already have a devenv-based setup for local development, but repos that
  # consume effect-utils as a flake input still need a flake entry point so they
  # can import Nix helpers (for example lib.mkCliPackages) with a stable API.
  # This keeps the build logic reusable without requiring devenv in the parent.
  #
  # Buck product wrappers and capabilities share the effect-utils package
  # graph, so downstream repos should make their root nixpkgs follow
  # `effect-utils/nixpkgs` instead of overriding the input the other way around.
  # Flake nixConfig is independently honored by Nix on every runner. Never
  # list private caches here: genie can only guard explicit job composition.
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
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      tsgo,
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
        macosAppExample = import ./nix/macos-app/example.nix {
          inherit pkgs;
          nixpkgsRevision = nixpkgs.rev;
        };
        weaverPackages =
          ((import ./nix/weaver-flake/flake.nix).outputs { inherit nixpkgs; }).packages.${system};
        cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
        pnpm = import ./nix/pnpm.nix { inherit pkgs; };
        stylexNextFixture = import ./nix/stylex-next-fixture.nix { inherit pkgs pnpm; };
        nodePtyNative = import ./nix/node-pty-native.nix { inherit pkgs; };
        providerCliPackages = {
          vercel-cli = import ./nix/provider-clis/vercel-cli { inherit pkgs; };
          netlify-cli = import ./nix/provider-clis/netlify-cli { inherit pkgs; };
          wrangler = import ./nix/provider-clis/wrangler { inherit pkgs; };
        };
        # Native products are built from this pinned source revision, imported
        # with descriptor/runtime validation and substituted from Cachix.
        # Cache misses rebuild through the same Buck graph.
        nativeProductPackages = import ./nix/buck2-products/native.nix {
          inherit
            pkgs
            mkBuckProductFromSource
            pnpmArchives
            ;
          capabilities = buck2Capabilities;
          repositoryRoot = ./.;
        };
        buck2 = import ./nix/buck2.nix { inherit pkgs; };
        mkBuckProductFromSource = import ./nix/buck2-products/from-source.nix {
          inherit pkgs buck2;
        };
        pnpmArchives = import ./nix/buck2-products/pnpm-archives.nix { inherit pkgs; };
        buckProductsFromSource = import ./nix/buck2-products/source-recipes.nix {
          inherit
            mkBuckProductFromSource
            pnpmArchives
            ;
          capabilities = buck2Capabilities;
          # Dirty flake inputs have no commit identity. The publisher rejects dirty trees and
          # verifies this field against HEAD before mutation, so the sentinel cannot escape.
          producerCommit = self.sourceInfo.rev or "0000000000000000000000000000000000000000";
          repositoryRoot = ./.;
        };
        # Compiled-executable products imported for this host platform (compiled.nix).
        buckCompiledProducts = import ./nix/buck2-products/compiled.nix {
          inherit
            pkgs
            mkBuckProductFromSource
            pnpmArchives
            ;
          capabilities = buck2Capabilities;
          repositoryRoot = ./.;
        };
        viteRuntimeFixture =
          if system != "x86_64-linux" then
            null
          else
            let
              fixtureSource = mkBuckProductFromSource {
                capabilities = buck2Capabilities;
                inherit pnpmArchives;
                nativeStorePackages = [
                  {
                    name = "node-pty";
                    package = "${nodePtyNative}/node_modules/node-pty";
                  }
                ];
                producerCommit = self.sourceInfo.rev or "0000000000000000000000000000000000000000";
                repositoryRoot = ./.;
                product = {
                  name = "vite-runtime-closure-fixture";
                  kind = "fixture";
                  target = "//buck2/products:vite_runtime_fixture_module";
                  outputName = "vite-runtime-fixture.mjs";
                };
                runtimeClosureTarget = "//buck2/products:vite_runtime_closure_fixture";
              };
            in
            import ./nix/buck2-products/vite-runtime-fixture.nix {
              inherit pkgs;
              artifact = "${fixtureSource}/vite-runtime-fixture.mjs";
              runtimeClosure = {
                artifact = "${fixtureSource}/runtime-closure";
                expectedDigest = "0341b46ca478ea0c96b499f1ed834bb644ab677319687edf1a60478fa014d551";
              };
              nativeNodePackages = [
                {
                  name = "@fixture/native-slot";
                  package = pkgs.writeTextDir "index.js" "module.exports = 'native-slot-ok'\n";
                }
              ];
            };
        buck2-go = import ./nix/go.nix { inherit pkgs; };
        buck2-bun-compile-runtime = import ./nix/bun-compile-runtime.nix { inherit pkgs; };
        buck2-stage0-tools = import ./nix/buck2-stage0-tools.nix { inherit pkgs; };
        buck2-rust-toolchain-capability =
          import ./nix/workspace-tools/lib/buck2-rust-toolchain-capability.nix
            {
              inherit pkgs;
              nixpkgsRevision = nixpkgs.rev;
            };
        capabilityPackages = {
          inherit buck2 buck2-go buck2-bun-compile-runtime;
          inherit pnpm;
          bun = pkgs.bun;
          buck2-node = pkgs.writeShellScriptBin "node" ''
            exec ${pkgs.nodejs_24 or pkgs.nodejs}/bin/node "$@"
          '';
          buck2-python-bootstrap = pkgs.writeShellScriptBin "python3" ''
            exec ${pkgs.python3}/bin/python3 "$@"
          '';
          buck2-archive-tool = buck2-stage0-tools.archive-tool;
          buck2-events = buck2-stage0-tools.events;
          buck2-product = buck2-stage0-tools.product;
          buck2-fingerprint = buck2-stage0-tools.fingerprint;
          # The native env binary must start before any interpreter; a shell
          # wrapper could read ambient BASH_ENV before clearing the environment.
          # Use explicit multicall dispatch; capability paths are canonicalized.
          buck2-action-env = pkgs.coreutils;
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
          buck2-rust-wasm-compiler = buck2-rust-toolchain-capability.packages.rust-wasm-compiler;
          buck2-rust-wasm-rustdoc = buck2-rust-toolchain-capability.packages.rust-wasm-rustdoc;
          buck2-rust-wasm-linker = buck2-rust-toolchain-capability.packages.rust-wasm-linker;
          buck2-wasm-bindgen = buck2-rust-toolchain-capability.packages.wasm-bindgen;
          buck2-wasm-opt = buck2-rust-toolchain-capability.packages.wasm-opt;
          effect-tsgo = tsgo.packages.${system}.effect-tsgo;
          cargo = pkgs.writeShellScriptBin "cargo" ''
            exec ${pkgs.cargo}/bin/cargo "$@"
          '';
          deadnix = pkgs.deadnix;
          nix = pkgs.writeShellScriptBin "nix" ''
            exec ${pkgs.nix}/bin/nix "$@"
          '';
          nixfmt = pkgs.nixfmt-rfc-style;
          oxfmt = pkgs.oxfmt;
          oxlint-with-plugins = import ./nix/oxlint-with-plugins.nix {
            inherit pkgs oxlintNpm;
          };
          inherit weaver;
          semconv-model = semconv-model-capability;
        };
        buck2Rules = import ./nix/buck2-rules {
          inherit pkgs buck2 pnpmArchives;
          src = ./.;
        };
        buck2Bubblewrap = import ./nix/bubblewrap.nix { inherit pkgs; };
        buck2Capabilities = import ./nix/buck2-capabilities.nix {
          inherit pkgs capabilityPackages;
          src = ./.;
          extraCapabilities = {
            stylex-next-fixture = {
              kind = "directory";
              package = stylexNextFixture;
              protocol = "effect-utils/stylex-next-fixture/v1";
            };
          }
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            bubblewrap = {
              kind = "executable";
              package = buck2Bubblewrap;
              executable = "bin/bwrap";
              protocol = "containers/bubblewrap/v1";
            };
          };
        };
        # Buck is the sole producer for admitted repository products.
        trackedBuck2Products = import ./nix/buck2-products {
          inherit pkgs;
          fromSourceProducts = buckProductsFromSource;
        };
        oxlintNpm = import ./nix/oxlint-npm.nix {
          inherit pkgs pnpmArchives;
          bun = pkgs.bun;
          products = trackedBuck2Products.products;
        };
        weaver = weaverPackages.weaver;
        semconv-model = weaverPackages.semconv-model;
        semconv-model-capability = pkgs.runCommand "buck2-semconv-model-capability" { } ''
          mkdir -p "$out/bin" "$out/share"
          ln -s ${semconv-model} "$out/share/semconv-model"
          cat > "$out/bin/semconv-model" <<EOF
          #!${pkgs.runtimeShell}
          printf '%s\\n' "$out/share/semconv-model"
          EOF
          chmod +x "$out/bin/semconv-model"
        '';
        cliPackages = import ./nix/workspace-tools/lib/buck2-product-candidates.nix {
          inherit
            pkgs
            gitRev
            commitTs
            dirty
            ;
          products = trackedBuck2Products.products;
          nativeProducts = nativeProductPackages;
          typeProofCompilerBin = "${tsgo.packages.${system}.tsgo}/bin/tsgo";
        };
        # Exact retained repository products used by required shell activation,
        # task exec strings and capabilities. Publishing this closure also
        # publishes the source bridge and validator outputs behind each import.
        ciTestShellProducts = {
          buck2-capabilities = buck2Capabilities;
          inherit (providerCliPackages) netlify-cli vercel-cli;
          inherit (capabilityPackages)
            buck2
            buck2-archive-tool
            buck2-events
            buck2-fingerprint
            buck2-product
            pnpm
            oxlint-with-plugins
            ;
          inherit (nativeProductPackages) otelite otel-scrape typescript-api-server;
          inherit (cliPackages)
            genie
            megarepo
            ci-tools
            gh-ci-utils
            notion-cli
            tui-stories
            ;
          cli-build-stamp = cliBuildStamp.package;
          otel-span = import ./nix/devenv-modules/otel/otel-span.nix { inherit pkgs; };
        };
        githubRepoSettingsGenie = import ./nix/gh-settings-genie.nix {
          inherit pkgs;
          genie = cliPackages.genie;
          sourceProduct = buckProductsFromSource.genie;
        };
        mkGithubRepoSettingsLauncher = import ./nix/github-repo-settings.nix {
          inherit pkgs;
          genieBin = "${githubRepoSettingsGenie}/bin/genie";
        };
        githubRepoSettingsApps = pkgs.lib.genAttrs [ "gh-apply-settings" "gh-check-settings" ] (
          name:
          flake-utils.lib.mkApp {
            drv = mkGithubRepoSettingsLauncher (if name == "gh-apply-settings" then "apply" else "check");
            exePath = "/bin/${name}";
          }
        );

      in
      {
        buckProducts = trackedBuck2Products;
        checks = {
          stage0-cargo-metadata = buck2-stage0-tools.metadata-check;
        }
        // pkgs.lib.optionalAttrs (system == "aarch64-darwin") {
          macos-app-host-stability = macosAppExample.check;
          macos-app-primitives = macosAppExample.primitives;
          macos-app-appkit-link = import ./nix/macos-app/appkit-link-check.nix {
            inherit pkgs;
            nixpkgsRevision = nixpkgs.rev;
          };
        };
        packages =
          cliPackages
          // providerCliPackages
          // nativeProductPackages
          // buckCompiledProducts
          // capabilityPackages
          // {
            editor-view-lease = pkgs.callPackage ./nix/editor-view-lease { };
            buck2-rules = buck2Rules;
            buck2-capabilities = buck2Capabilities;
            stylex-next-fixture = stylexNextFixture;
            ci-test-shell-products = pkgs.linkFarm "ci-test-shell-products" (
              pkgs.lib.mapAttrsToList (name: path: { inherit name path; }) ciTestShellProducts
            );
            buck2-pnpm-archives = pnpmArchives;
            cli-build-stamp = cliBuildStamp.package;
            otel-span = import ./nix/devenv-modules/otel/otel-span.nix { inherit pkgs; };
            restate = import ./nix/restate.nix {
              pkgs = import nixpkgs {
                inherit system;
                config.allowUnfreePredicate = pkg: pkgs.lib.getName pkg == "restate";
              };
            };
            # Both the rasterizer and fonts follow this repository's locked nixpkgs.
            # Ignore runner fonts so identical SVGs have a deterministic font closure.
            pipeline-waterfall-rasterizer = pkgs.writeShellScriptBin "pipeline-waterfall-rasterizer" ''
              exec ${pkgs.resvg}/bin/resvg \
                --skip-system-fonts \
                --use-fonts-dir ${pkgs.dejavu_fonts}/share/fonts/truetype \
                "$@"
            '';
            gh-settings-genie = githubRepoSettingsGenie;
            buck-products-from-source = pkgs.linkFarm "effect-utils-buck-products-from-source" (
              pkgs.lib.mapAttrsToList (name: path: {
                name = pkgs.lib.replaceStrings [ "@" "/" ] [ "" "-" ] name;
                inherit path;
              }) buckProductsFromSource
            );
            oxlint-npm = oxlintNpm;
            node-pty-native = nodePtyNative;
          }
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            buck2-bubblewrap = buck2Bubblewrap;
          }
          // pkgs.lib.optionalAttrs (system == "aarch64-darwin") {
            macos-app-example = macosAppExample.example;
            macos-app-integration = macosAppExample.integration;
            macos-app-ctl-integration = macosAppExample.ctlIntegration;
            macos-app-launchd-smoke = macosAppExample.launchdSmoke;
          }
          // pkgs.lib.optionalAttrs (system == "x86_64-linux") {
            buck2-vite-runtime-closure-fixture = viteRuntimeFixture;
          }
          // pkgs.lib.mapAttrs' (
            name: value:
            pkgs.lib.nameValuePair "buck-product-${pkgs.lib.replaceStrings [ "@" "/" ] [ "" "-" ] name}-from-source" value
          ) buckProductsFromSource;
        # Direnv helper for comparing expected CLI outputs to PATH entries.
        cliOutPaths = {
          genie = cliPackages.genie.outPath;
          ci-tools = cliPackages.ci-tools.outPath;
          gh-ci-utils = cliPackages.gh-ci-utils.outPath;
          megarepo = cliPackages.megarepo.outPath;
          tui-stories = cliPackages.tui-stories.outPath;
          notion-cli = cliPackages.notion-cli.outPath;
          notion-md = cliPackages.notion-md.outPath;
        };

        apps =
          githubRepoSettingsApps
          // {
            ci-storage = flake-utils.lib.mkApp {
              drv = nativeProductPackages.ci-storage;
              exePath = "/bin/ci-storage";
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
      binaryCaches =
        let
          descriptors = import ./nix/binary-caches.nix;
          cache = descriptors."overeng-effect-utils";
        in
        assert cache.kind == "nix-binary" && cache.visibility == "public";
        assert nixConfig.extra-substituters == [ cache.uri ];
        assert nixConfig.extra-trusted-public-keys == [ cache.publicKey ];
        descriptors;
      # Devenv modules for importing into other repos
      devenvModules = {
        # Lightweight native-devenv + effect-utils capture, optionally composed
        # with the full Collector/Tempo/Grafana stack.
        observability =
          args:
          { pkgs, ... }@moduleArgs:
          (import ./nix/devenv-modules/observability.nix (
            { otelite = self.packages.${pkgs.stdenv.hostPlatform.system}.otelite; } // args
          ))
            moduleArgs;
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
          setup = import ./nix/devenv-modules/tasks/shared/setup.nix;
          check = import ./nix/devenv-modules/tasks/shared/check.nix;
          devenv-eval-input-budget = import ./nix/devenv-modules/tasks/shared/devenv-eval-input-budget.nix;
          clean = import ./nix/devenv-modules/tasks/shared/clean.nix;
          test = import ./nix/devenv-modules/tasks/shared/test.nix;
          test-playwright = import ./nix/devenv-modules/tasks/shared/test-playwright.nix;
          storybook = import ./nix/devenv-modules/tasks/shared/storybook.nix;
          netlify = import ./nix/devenv-modules/tasks/shared/netlify.nix;
          vercel = import ./nix/devenv-modules/tasks/shared/vercel.nix;
          cloudflare-workers = import ./nix/devenv-modules/tasks/shared/cloudflare-workers.nix;
          workflow-report = import ./nix/devenv-modules/tasks/shared/workflow-report.nix;
          lint-nix = import ./nix/devenv-modules/tasks/shared/lint-nix.nix;
          lint-oxc = import ./nix/devenv-modules/tasks/shared/lint-oxc.nix;
          bun = import ./nix/devenv-modules/tasks/shared/bun.nix;
          buck2-rust-deps = import ./nix/devenv-modules/tasks/shared/buck2-rust-deps.nix;
          changesets = import ./nix/devenv-modules/tasks/shared/changesets.nix;
          github-ruleset =
            args:
            { pkgs, ... }@moduleArgs:
            (import ./nix/devenv-modules/tasks/shared/github-ruleset.nix (
              {
                genieBin = "${self.packages.${pkgs.stdenv.hostPlatform.system}.gh-settings-genie}/bin/genie";
              }
              // args
            ))
              moduleArgs;
          # gh:apply-labels / gh:check-labels — reconcile .github/labels.json with live labels.
          # Parameterized by `{ repo = "owner/name"; }`; consumed like the other task modules.
          gh-labels = import ./nix/devenv-modules/gh-labels.nix;
          pnpm = import ./nix/devenv-modules/tasks/shared/pnpm.nix;
          nix-cli = import ./nix/devenv-modules/tasks/shared/nix-cli.nix;
          flake-lock-duplicates = import ./nix/devenv-modules/tasks/shared/flake-lock-duplicates.nix;
          secretspec = import ./nix/devenv-modules/tasks/shared/secretspec.nix;
          # Prevent commits on default branch and optionally enforce worktree-only workflow
          worktree-guard = import ./nix/devenv-modules/tasks/shared/worktree-guard.nix;
          # Explicit root-scoped teardown before an operator removes a worktree
          worktree-teardown = ./nix/devenv-modules/tasks/shared/worktree-teardown.nix;
          # Note: local/ directory contains effect-utils specific tasks (not exported)
        };
      };

      lib = import ./nix/lib.nix { inherit self nixpkgs tsgo; };

      # For consuming CLIs from other repos, use:
      #   effectUtils.packages.${system}.genie
      #   effectUtils.packages.${system}.ci-tools
      #   effectUtils.packages.${system}.megarepo
      # See the stack-level Nix/devenv CLI distribution policy docs.
    };
}
