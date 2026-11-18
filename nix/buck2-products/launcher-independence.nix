# Evaluation-only regression proof: force drvPath/recipeIdentity, never realize inputs.
{
  pkgs,
  buck2,
  capabilities,
  pnpmArchives,
  baseline,
  repositoryRoot,
  producerCommit,
  sourceInfo,
}:
let
  lib = pkgs.lib;
  launcherFiles = [
    "buck2-entrypoint.ts"
    "buck2-cache-posture.ts"
    "buck2-file-watcher.ts"
    "buck2-stdio.c"
    "buck2-entrypoint.sh"
  ];
  variant =
    changed: comment:
    import ../buck2.nix {
      inherit pkgs;
      launcherSource = pkgs.linkFarm "buck2-launcher-variant" (
        map (name: {
          inherit name;
          path =
            if name == changed then
              builtins.toFile name (builtins.readFile (repositoryRoot + "/scripts/${name}") + comment)
            else
              repositoryRoot + "/scripts/${name}";
        }) launcherFiles
      );
    };
  variants = [
    (variant "buck2-entrypoint.ts" "\n// launcher independence control\n")
    (variant "buck2-entrypoint.sh" "\n# launcher independence control\n")
  ];
  recipes =
    tool: identity:
    let
      mkBuckProductFromSource = import ./from-source.nix {
        inherit pkgs;
        buck2 = tool;
      };
      args = {
        inherit
          pkgs
          capabilities
          pnpmArchives
          repositoryRoot
          mkBuckProductFromSource
          ;
      };
    in
    {
      cache = import ./source-recipes.nix {
        inherit
          capabilities
          pnpmArchives
          repositoryRoot
          producerCommit
          mkBuckProductFromSource
          ;
      };
      native = import ./native.nix (args // { sourceInfo = identity; });
      compiled = import ./compiled.nix args;
    };
  nativeChanged = buck2 // {
    native = buck2.native.overrideAttrs (_: {
      launcherIndependenceControl = "native-change";
    });
  };
  positive = recipes nativeChanged sourceInfo;
  identityChanged =
    (recipes buck2 (
      sourceInfo
      // {
        # Test-only source revision: changing provenance must not recompile a payload.
        rev =
          if (sourceInfo.rev or null) == "1111111111111111111111111111111111111111" then
            "2222222222222222222222222222222222222222"
          else
            "1111111111111111111111111111111111111111";
      }
    )).native;
  sourceProduct = product: product.buck2Product or product;
  every =
    predicate: candidate:
    lib.all (
      group:
      lib.all (name: predicate candidate.${group}.${name} baseline.${group}.${name}) (
        builtins.attrNames baseline.${group}
      )
    ) (builtins.attrNames baseline);
  same = every (
    candidate: original:
    candidate.drvPath == original.drvPath
    &&
      (sourceProduct candidate).compileProduct.drvPath == (sourceProduct original).compileProduct.drvPath
    && (sourceProduct candidate).recipeIdentity == (sourceProduct original).recipeIdentity
  );
in
assert lib.assertMsg (
  builtins.length variants == 2
  && (builtins.elemAt variants 0).drvPath != (builtins.elemAt variants 1).drvPath
) "launcher independence: synthetic launcher edits must differ";
assert lib.all (
  tool:
  lib.assertMsg (tool.drvPath != buck2.drvPath) "launcher independence: edit did not change launcher"
  && lib.assertMsg (same (recipes tool sourceInfo)) "launcher independence: launcher edit changed a product"
) variants;
assert lib.assertMsg (every (
  candidate: original:
  candidate.drvPath != original.drvPath
  &&
    (sourceProduct candidate).compileProduct.drvPath != (sourceProduct original).compileProduct.drvPath
  && (sourceProduct candidate).recipeIdentity != (sourceProduct original).recipeIdentity
) positive) "launcher independence: native change must change every product";
assert lib.assertMsg (lib.all
  (
    name:
    let
      original = baseline.native.${name};
      candidate = identityChanged.${name};
    in
    !(original ? unwrapped)
    || (
      candidate.drvPath != original.drvPath
      &&
        (sourceProduct candidate).compileProduct.drvPath == (sourceProduct original).compileProduct.drvPath
      && (sourceProduct candidate).recipeIdentity == (sourceProduct original).recipeIdentity
    )
  )
  (builtins.attrNames baseline.native)
) "native identity: revision must change the runtime wrapper, not the Buck compile action";
pkgs.runCommand "buck2-launcher-independence" { } "touch $out"
