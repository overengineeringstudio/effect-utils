#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
export BUCK2_PRODUCTS_REPO="$repo_root"
nix eval --read-only --option allow-import-from-derivation false --raw \
  "$repo_root#packages.x86_64-linux.buck2-vite-runtime-closure-fixture.drvPath" >/dev/null
nix eval --impure --json --expr '
  let
    checkout = builtins.getEnv "BUCK2_PRODUCTS_REPO";
    flake = builtins.getFlake ("git+file://" + checkout + "?shallow=1");
    # Compare the same Git-filtered source; activation can add ignored checkout files.
    repo = /. + builtins.unsafeDiscardStringContext flake.outPath;
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    lib = pkgs.lib;
    project = repositoryRoot: import (repo + "/nix/buck2-products/root-projection.nix") {
      inherit pkgs; repositoryRoot = /. + builtins.unsafeDiscardStringContext (toString repositoryRoot);
    };
    withoutTests = builtins.path {
      path = repo; name = "root-projection-without-tests";
      filter = path: type: !(lib.hasPrefix "${toString repo}/buck2/tests" path)
        && !(lib.hasPrefix "${toString repo}/.git" path);
    };
    before = toString (project repo); after = toString (project withoutTests);
    files = map toString (import (repo + "/nix/buck2-products/buck-inputs.nix") {
      inherit lib; repositoryRoot = repo;
    }).files;
    excluded = [ "buck2/tests/" "buck2/dependencies/fixtures/" "buck2/products/BUCK"
      "buck2/static/BUCK" "buck2/provenance/BUCK" "buck2/rust/library_closure_probe.bzl" ];
    inventories = map (name: builtins.fromJSON (builtins.readFile
      (repo + "/nix/buck2-products/${name}-targets.json"))) [ "cache" "native" "compiled" ];
    declarations = lib.concatMap (inventory: inventory.products) inventories;
    packages = flake.packages.${builtins.currentSystem};
    fixture = flake.packages.x86_64-linux.buck2-vite-runtime-closure-fixture.drvPath;
    extended = import (repo + "/nix/buck2-products/buck-inputs.nix") {
      inherit lib; repositoryRoot = repo;
      extraEntryTargets = [ "//buck2/products:vite_runtime_fixture_module" "//buck2/products:vite_runtime_closure_fixture" ];
    };
    remove = source: relative: builtins.path {
      path = source; name = "source";
      filter = path: type: path != "${toString source}/${relative}"
        && !(lib.hasPrefix "${toString source}/${relative}/" path);
    };
    scopedNames = [ "ci-tools" "gh-ci-utils" "notion-cli" "notion-db-runtime" "tui-stories" ];
    checkProduct = declaration: let
        cache = builtins.any (product: product.target == declaration.target) (builtins.head inventories).products;
        compiled = declaration.kind == "compiled-executable";
        exported = if cache then
          packages."buck-product-${lib.replaceStrings [ "@" "/" ] [ "" "-" ] declaration.name}-from-source"
        else packages."${declaration.name}${lib.optionalString compiled "-compiled"}";
        recipe = (exported.buck2Product or exported).compileProduct;
        source = recipe.source;
        rules = if recipe.rootProjection == null then source else recipe.rootProjection;
        package = builtins.head (lib.splitString ":" (lib.last (lib.splitString "//" declaration.target)));
        ownFiles = lib.fileset.toList (lib.fileset.fileFilter (
          file: (file.hasExt "ts" || file.hasExt "tsx" || file.hasExt "rs")
            && !(lib.hasInfix ".test." file.name) && !(lib.hasSuffix ".genie.ts" file.name)
        ) (/. + builtins.unsafeDiscardStringContext "${toString source}/${package}/src"));
        ownFile = lib.removePrefix "${toString source}/" (toString (builtins.head ownFiles));
        ruleFile = "buck2/platforms/defs.bzl";
        changedSource = remove source ownFile; changedRules = remove rules ruleFile;
        sourceRecipe = recipe.overrideAttrs { src = changedSource; };
        ruleRecipe = recipe.overrideAttrs (
          if recipe.rootProjection == null then { src = changedRules; }
          else { buildPhase = builtins.replaceStrings [ (toString rules) ] [ (toString changedRules) ] recipe.buildPhase; }
        );
        # Scoped JS products retain these actual staged inputs. Package configs
        # are self-contained; there is no repository-root tsconfig base.
        # The raw pnpm lock is translated: its SHA inventory is loaded by the
        # dependencies BUCK and its archive digests feed pnpmArchives.
        inputControls = if !(builtins.elem declaration.name scopedNames) then [ ] else map (input:
          let
            root = if input.rules or false then rules else source;
            changed = remove root input.path;
            changedRecipe = recipe.overrideAttrs (
              if !(input.rules or false) || recipe.rootProjection == null then { src = changed; }
              else {
                buildPhase = builtins.replaceStrings [ (toString rules) ]
                  [ (toString changed) ] recipe.buildPhase;
              }
            );
          in
            assert lib.assertMsg (builtins.pathExists (root + "/${input.path}"))
              "${declaration.name}: missing scoped input ${input.path}";
            assert lib.assertMsg (recipe.drvPath != changedRecipe.drvPath)
              "${declaration.name}: compile recipe ignores ${input.path}";
            input.path
        ) [
          { path = "package.json"; }
          { path = "patches/@myobie__pty@0.10.0.patch"; }
          { path = "${package}/tsconfig.json"; }
          { path = "${package}/BUCK"; }
          { path = "buck2/dependencies/pnpm-lock.sha256.json"; rules = true; }
        ];
        testlessRecipe = (import (repo + "/nix/buck2-products/from-source.nix") {
          inherit pkgs; buck2 = packages.buck2;
        }) {
          product = declaration;
          inherit (recipe) capabilities pnpmArchives cargoArchives producerCommit
            repositorySource sourcePaths runtimeClosureTarget nativeStorePackages;
          repositoryRoot = /. + builtins.unsafeDiscardStringContext (toString withoutTests);
          rootProjection = if recipe.rootProjection == null then null else project withoutTests;
        };
      in
        assert builtins.pathExists (rules + "/${ruleFile}");
        assert recipe.drvPath != sourceRecipe.drvPath && recipe.drvPath != ruleRecipe.drvPath;
        assert toString source == toString (remove source "buck2/tests")
          && toString rules == toString (remove rules "buck2/tests");
        assert recipe.drvPath == testlessRecipe.compileProduct.drvPath;
        { name = declaration.name; inherit ownFile ruleFile inputControls; };
    products = map checkProduct declarations;
  in
    assert before == after;
    assert builtins.all (prefix: !(builtins.any (lib.hasPrefix "${toString repo}/${prefix}") files)) excluded;
    assert builtins.elem (repo + "/buck2/products/vite-runtime-fixture.mjs") extended.files;
    assert builtins.all (name: builtins.any (entry: entry.name == name) products) [ "genie" "typescript-api-server" "otelite" "otel-scrape" ];
    assert builtins.all (name: builtins.any (entry: entry.name == name) products) scopedNames;
    { rootProjection = before; testTreeIndependent = true; inherit products fixture; }
'
