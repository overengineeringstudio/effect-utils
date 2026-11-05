{
  self,
  nixpkgs,
  tsgo,
}:
{
  # CLI guard helpers: .mkCliGuard for single guards, .fromTasks/.stripGuards for task-driven guards
  cliGuard = { pkgs }: import ./devenv-modules/tasks/lib/cli-guard.nix { inherit pkgs; };

  # Build a materialized standalone Buck root for a consumer checkout.
  mkConsumerBuckRoot = args: import ./buck2-products/consumer-root.nix args;
  # Consumers extend the same capability projection with named, immutable
  # Nix inputs; producer tool declarations remain owned by buck2-member.json.
  mkBuck2Capabilities =
    {
      pkgs,
      extraCapabilities ? { },
    }:
    let
      base = self.packages.${pkgs.stdenv.hostPlatform.system}.buck2-capabilities;
    in
    import ./buck2-capabilities.nix {
      inherit pkgs;
      extraCapabilities = base.passthru.extraCapabilities // extraCapabilities;
      inherit (base.passthru) capabilityPackages src;
    };

  # Stage private package products (decision 0037) for pnpm and Buck consumers
  # from the producer manifest's substituted store paths.
  # Usage: effectUtils.lib.mkPrivateProductTarballs { inherit pkgs manifest schema; }
  mkPrivateProductTarballs = args: import ./buck2-products/private-product-tarballs.nix args;

  # Rebuild a declared Buck product from source inside the Nix sandbox.
  # For native and compiled-executable products, importNative = true realizes
  # and validates the artifact without a caller-supplied source product.
  mkBuckProductFromSource =
    {
      pkgs,
      buck2 ? self.packages.${pkgs.stdenv.hostPlatform.system}.buck2,
    }:
    import ./buck2-products/from-source.nix { inherit pkgs buck2; };

  # Verify and import a published Buck artifact into a normal Nix output for
  # wrapping and later Home Manager/system activation.
  mkBuck2ArtifactImport =
    { pkgs }: import ./workspace-tools/lib/buck2-artifact-import.nix { inherit pkgs; };

  # Offline crate supply for mkBuckProductFromSource `cargoArchives`.
  # gitSources maps GitHub owner/repo to a pinned flake input (or local path);
  # absent keys retain the reviewed GitHub archive fetch and digest.
  mkBuck2CargoArchives =
    {
      pkgs,
      thirdPartyBuckFiles,
      gitSources ? { },
    }:
    import ./workspace-tools/lib/buck2-cargo-archives.nix {
      inherit pkgs thirdPartyBuckFiles gitSources;
    };

  # Verify and import one tracked Buck JavaScript product (descriptor plus
  # content-addressed module bytes) into a wrappable Nix output.
  mkBuck2JavaScriptProductImport =
    { pkgs }: import ./workspace-tools/lib/javascript-product-import.nix { inherit pkgs; };

  # Wrap this effect-utils revision's tracked Buck JavaScript products into
  # candidate packages. Callers can replace `products` for an explicit
  # manifest experiment; normal consumers inherit this revision's manifest.
  # Usage: effectUtils.lib.mkBuck2ProductCandidates { inherit pkgs; }
  mkBuck2ProductCandidates =
    args:
    import ./workspace-tools/lib/buck2-product-candidates.nix (
      {
        nativeProducts = self.packages.${args.pkgs.stdenv.hostPlatform.system};
        products = self.buckProducts.${args.pkgs.stdenv.hostPlatform.system}.products;
        typeProofCompilerBin = "${tsgo.packages.${args.pkgs.stdenv.hostPlatform.system}.tsgo}/bin/tsgo";
      }
      // args
    );

  # Shell helper for runtime CLI build stamps.
  cliBuildStamp = { pkgs }: import ./workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };

  # Build Grafonnet dashboards against the shared OTEL dashboard library.
  # Returns a linkFarm (Nix store path) containing compiled JSON files.
  buildOtelDashboards =
    {
      pkgs,
      src,
      dashboardNames,
    }:
    import ./devenv-modules/otel/build-dashboards.nix { inherit pkgs src dashboardNames; };

  # Standalone otel-span CLI (run + emit subcommands).
  # Can be added to devenv packages without importing the full OTEL module.
  mkOtelSpan = { pkgs }: import ./devenv-modules/otel/otel-span.nix { inherit pkgs; };

  # Consumers can fail closed at evaluation before requesting a legacy cutover.
  macosAppCapabilities.legacyIncumbentImport = true;

  mkMacosApp =
    args:
    import ./macos-app/default.nix {
      pkgs = args.pkgs;
      nixpkgsRevision = nixpkgs.rev;
    } (builtins.removeAttrs args [ "pkgs" ]);

  mkMacosPermissionsHost =
    args:
    import ./permissions-host/default.nix {
      pkgs = args.pkgs;
      nixpkgsRevision = nixpkgs.rev;
    } (builtins.removeAttrs args [ "pkgs" ]);

  # Convenience helper for bundling the common genie/megarepo CLIs from
  # this effect-utils revision's tracked Buck products. An explicit
  # `products` argument remains available for manifest experiments.
  mkCliPackages =
    args:
    import ./workspace-tools/lib/mk-cli-packages.nix (
      {
        nativeProducts = self.packages.${args.pkgs.stdenv.hostPlatform.system};
        products = self.buckProducts.${args.pkgs.stdenv.hostPlatform.system}.products;
        typeProofCompilerBin = "${tsgo.packages.${args.pkgs.stdenv.hostPlatform.system}.tsgo}/bin/tsgo";
      }
      // args
    );

  # npm oxlint with NAPI bindings plus the two tracked immutable
  # @overeng/oxc-config JavaScript plugin products.
  # Usage: effectUtils.lib.mkOxlintNpm { inherit pkgs; bun = pkgs.bun; }
  mkOxlintNpm =
    {
      pkgs,
      bun,
      products ? self.buckProducts.${pkgs.stdenv.hostPlatform.system}.products,
    }:
    import ./oxlint-npm.nix {
      inherit pkgs bun products;
      pnpmArchives = import ./buck2-products/pnpm-archives.nix { inherit pkgs; };
    };

  # oxlint wrapper that substitutes the overeng and @stylexjs configured
  # entries with their separate tracked module paths. Projects without
  # either namespace pass through to plain oxlint-npm.
  # Usage: effectUtils.lib.mkOxlintWithPlugins { inherit pkgs; oxlintNpm = effectUtils.packages.\${system}.oxlint-npm; }
  mkOxlintWithPlugins =
    {
      pkgs,
      oxlintNpm,
    }:
    import ./oxlint-with-plugins.nix { inherit pkgs oxlintNpm; };

  # Pinned pnpm for the entire megarepo ecosystem.
  # Usage: effectUtils.lib.mkPnpm { inherit pkgs; }
  mkPnpm = { pkgs }: import ./pnpm.nix { inherit pkgs; };
}
