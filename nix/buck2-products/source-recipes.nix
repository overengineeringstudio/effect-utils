# From-source recipe for every cache product, keyed by product name.
#
# The generated cache-targets.json is the single product inventory: cache.nix
# reads it as the target set and this file derives one recipe per entry, so a
# product can never be published without a recipe or vice versa.
{
  pkgs,
  capabilities,
  mkBuckProductFromSource,
  pnpmArchives,
  producerCommit,
  repositoryRoot ? ../..,
}:

let
  inventory = builtins.fromJSON (builtins.readFile ./cache-targets.json);
  rootProjection = import ./root-projection.nix { inherit pkgs repositoryRoot; };
in
builtins.listToAttrs (
  map (product: {
    name = product.name;
    value = mkBuckProductFromSource {
      inherit
        pnpmArchives
        product
        producerCommit
        repositoryRoot
        ;
      capabilities = capabilities.selectProduct product;
      sourcePaths = product.sourcePaths or null;
      rootProjection = if product ? sourcePaths then rootProjection else null;
    };
  }) inventory.products
)
