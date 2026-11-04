#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
export BUCK2_PRODUCTS_REPO="$repo_root"
nix eval --impure --json --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_PRODUCTS_REPO");
    flake = builtins.getFlake ("git+file://" + toString repo + "?shallow=1");
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    lib = pkgs.lib;
    project = repositoryRoot: import (repo + "/nix/buck2-products/root-projection.nix") {
      inherit pkgs;
      repositoryRoot = builtins.toPath (toString repositoryRoot);
    };
    # Removing every test package is a stronger perturbation than editing one
    # BUCK file. Neither its presence nor its bytes may affect the source hash.
    withoutTests = builtins.path {
      path = repo;
      name = "root-projection-without-tests";
      filter = path: type:
        !(lib.hasPrefix "${toString repo}/buck2/tests" path)
        && !(lib.hasPrefix "${toString repo}/.git" path);
    };
    before = toString (project repo);
    after = toString (project withoutTests);
    files = map toString (import (repo + "/nix/buck2-products/buck-inputs.nix") {
      inherit lib;
      repositoryRoot = repo;
    });
    excluded = [
      "buck2/tests/"
      "buck2/dependencies/fixtures/"
      "buck2/products/BUCK"
      "buck2/static/BUCK"
      "buck2/provenance/BUCK"
      "buck2/rust/library_closure_probe.bzl"
    ];
    inventories = map (name: builtins.fromJSON (builtins.readFile (repo + "/nix/buck2-products/${name}-targets.json"))) [
      "cache" "native" "compiled"
    ];
    declarations = lib.concatMap (inventory: inventory.products) inventories;
    packages = flake.packages.${builtins.currentSystem};
    # Preserve the source name, so only file contents/membership affect hashes.
    remove = source: relative: builtins.path {
      path = source;
      name = "source";
      filter = path: type:
        path != "${toString source}/${relative}"
        && !(lib.hasPrefix "${toString source}/${relative}/" path);
    };
    checkProduct = declaration:
      let
        cache = !(declaration ? sourcePaths);
        compiled = declaration.kind == "compiled-executable";
        exported = if cache then
          packages."buck-product-${lib.replaceStrings [ "@" "/" ] [ "" "-" ] declaration.name}-from-source"
        else packages."${declaration.name}${lib.optionalString compiled "-compiled"}";
        recipe = exported.buck2Product or exported;
        source = recipe.source;
        rules = if recipe.rootProjection == null then source else recipe.rootProjection;
        package = builtins.head (lib.splitString ":" (lib.last (lib.splitString "//" declaration.target)));
        ownFiles = lib.fileset.toList (lib.fileset.fileFilter (
          file: (file.hasExt "ts" || file.hasExt "tsx" || file.hasExt "rs")
            && !(lib.hasInfix ".test." file.name)
            && !(lib.hasSuffix ".genie.ts" file.name)
        ) (builtins.toPath "${toString source}/${package}/src"));
        ownFile = lib.removePrefix "${toString source}/" (toString (builtins.head ownFiles));
        # Every product loads the platform rule API through its rule/toolchain
        # imports, including the root package eagerly loaded by Prelude.
        ruleFile = "buck2/platforms/defs.bzl";
        changedSource = remove source ownFile;
        changedRules = remove rules ruleFile;
        sourceRecipe = recipe.overrideAttrs { src = changedSource; };
        ruleRecipe = recipe.overrideAttrs (
          if recipe.rootProjection == null then { src = changedRules; }
          else { buildPhase = builtins.replaceStrings [ (toString rules) ] [ (toString changedRules) ] recipe.buildPhase; }
        );
      in
        assert ownFiles != [ ];
        assert builtins.pathExists (rules + "/${ruleFile}");
        assert toString source != toString changedSource;
        assert toString rules != toString changedRules;
        assert recipe.drvPath != sourceRecipe.drvPath;
        assert recipe.drvPath != ruleRecipe.drvPath;
        assert toString source == toString (remove source "buck2/tests");
        assert toString rules == toString (remove rules "buck2/tests");
        {
          name = declaration.name;
          inherit ownFile ruleFile;
          ownSourceChangesProjection = true;
          loadedRuleChangesProjection = true;
          testTreeIndependent = true;
        };
    products = map checkProduct declarations;
  in
    assert before == after;
    assert builtins.all (prefix: !(builtins.any (lib.hasPrefix "${toString repo}/${prefix}") files)) excluded;
    assert builtins.all (name: builtins.any (entry: entry.name == name) products)
      [ "genie" "typescript-api-server" "otelite" "otel-scrape" ];
    { rootProjection = before; testTreeIndependent = true; inherit products; }
'
