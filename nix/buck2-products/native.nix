# Native products for the evaluating host platform. Rust products use the
# pinned Cargo archive projection; the TypeScript API server uses pnpm archives.
# Every product is independently realized and validated by importNative.
{
  pkgs,
  mkBuckProductFromSource,
  capabilities,
  pnpmArchives,
  repositoryRoot ? ../..,
}:

let
  inventory = builtins.fromJSON (builtins.readFile ./native-targets.json);
  # Native shell products are source-addressed, not HEAD-addressed. Keep the
  # ordinary repository Buck root as a separate, declared rules input; package
  # source closures come from the committed Genie inventory below.
  rootProjection = import ./root-projection.nix { inherit pkgs repositoryRoot; };
  cargoArchives = import ../workspace-tools/lib/buck2-cargo-archives.nix {
    inherit pkgs;
    thirdPartyBuckFiles = [ (repositoryRoot + "/rust/third-party/BUCK") ];
  };
  validProduct =
    product:
    builtins.isAttrs product
    &&
      builtins.attrNames product == (
        [ "buildCapabilities" ]
        ++ pkgs.lib.optional (product ? cargoWorkspaceRoot) "cargoWorkspaceRoot"
        ++ [
          "kind"
          "name"
          "outputName"
          "sourcePaths"
          "target"
          "version"
        ]
      )
    && product.kind == "native"
    && builtins.isString product.name
    && builtins.match "[A-Za-z0-9][A-Za-z0-9._+-]*" product.name != null
    && product.outputName == "artifact.tar"
    && builtins.isString product.target
    &&
      builtins.match "effect_utils//packages/@overeng/[A-Za-z0-9._-]+:[A-Za-z0-9._+-]+" product.target
      != null
    && builtins.isString product.version
    && product.version != ""
    && (
      !(product ? cargoWorkspaceRoot)
      || (builtins.isString product.cargoWorkspaceRoot && product.cargoWorkspaceRoot == "rust")
    );
  names = map (product: product.name) inventory.products;
  targets = map (product: product.target) inventory.products;
in
assert
  builtins.attrNames inventory == [
    "products"
    "schema"
    "schemaVersion"
  ]
  && inventory.schema == "effect-utils/buck-native-targets/v1"
  && inventory.schemaVersion == 1
  && builtins.isList inventory.products
  && builtins.all validProduct inventory.products
  && builtins.length names == builtins.length (pkgs.lib.unique names)
  && builtins.length targets == builtins.length (pkgs.lib.unique targets)
  || throw "buck2-products: generated native target inventory is invalid";
builtins.listToAttrs (
  map (product: {
    inherit (product) name;
    value = mkBuckProductFromSource {
      inherit
        pnpmArchives
        product
        repositoryRoot
        rootProjection
        ;
      capabilities = capabilities.select product.buildCapabilities;
      sourcePaths = product.sourcePaths;
      # producerCommit is deliberately absent: unrelated commits must keep the
      # exact source product and its validated native import substitutable.
      cargoArchives = if product ? cargoWorkspaceRoot then cargoArchives else null;
      importNative = true;
      # The platform TypeScript server is fully static on Linux; Rust CLIs
      # and the Darwin server use the dynamic runtime inspector.
      runtimeKind =
        if product.name == "typescript-api-server" && pkgs.stdenv.hostPlatform.isLinux then
          "elf-static"
        else
          null;
    };
  }) inventory.products
)
