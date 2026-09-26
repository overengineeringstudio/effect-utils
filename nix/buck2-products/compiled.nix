# Compiled-executable products for the evaluating host platform.
#
# Each generated inventory row is rebuilt from source by Buck
# (`bun_compiled_product_executable` + `build_product`) and imported through
# the native realization path: descriptor contract, payload digest, archive
# scan, and the elf-dynamic / mach-o-dynamic runtime inspector. The protected
# publisher pushes these imports to Cachix per platform; consumers substitute
# the same derivations.
{
  mkBuckProductFromSource,
  capabilities,
  pnpmArchives,
  producerCommit,
  repositoryRoot ? ../..,
}:

let
  inventory = builtins.fromJSON (builtins.readFile ./compiled-targets.json);
  validProduct =
    product:
    builtins.isAttrs product
    && builtins.attrNames product == [
      "kind"
      "name"
      "outputName"
      "packagePath"
      "target"
      "version"
    ]
    && product.kind == "compiled-executable"
    && builtins.isString product.name
    && builtins.match "[A-Za-z0-9][A-Za-z0-9._+-]*" product.name != null
    && product.outputName == "artifact.tar"
    && builtins.isString product.packagePath
    && builtins.match "packages/@overeng/[A-Za-z0-9][A-Za-z0-9._-]*" product.packagePath != null
    && product.target == "effect_utils//${product.packagePath}:${product.name}-compiled-product"
    && builtins.isString product.version
    && product.version != "";
  names = map (product: product.name) inventory.products;
  uniqueNames = builtins.attrNames (builtins.listToAttrs (
    map (name: {
      inherit name;
      value = true;
    }) names
  ));
in
assert
  builtins.attrNames inventory == [
    "products"
    "schema"
    "schemaVersion"
  ]
  && inventory.schema == "effect-utils/buck-compiled-targets/v1"
  && inventory.schemaVersion == 1
  && builtins.isList inventory.products
  && builtins.all validProduct inventory.products
  && builtins.length names == builtins.length uniqueNames
  || throw "buck2-products: generated compiled target inventory is invalid";
builtins.listToAttrs (
  map (product: {
    name = "${product.name}-compiled";
    value = mkBuckProductFromSource {
      inherit
        capabilities
        pnpmArchives
        product
        producerCommit
        repositoryRoot
        ;
      importNative = true;
    };
  }) inventory.products
)
