# From-source recipe for every cache product, keyed by product name.
#
# The generated cache-targets.json is the single product inventory: cache.nix
# reads it as the target set and this file derives one recipe per entry, so a
# product can never be published without a recipe or vice versa.
{
  capabilities,
  pkgs,
  mkBuckProductFromSource,
  pnpmArchives,
  producerCommit,
  repositoryRoot ? ../..,
}:

let
  inventory = builtins.fromJSON (builtins.readFile ./cache-targets.json);
in
builtins.listToAttrs (
  map (product: {
    name = product.name;
    value =
      let
        compiled = mkBuckProductFromSource {
          inherit pnpmArchives product repositoryRoot;
          capabilities = capabilities.selectProduct product;
        };
      in
      compiled
      // {
        stamped = import ./stamp.nix {
          inherit pkgs compiled producerCommit;
        };
      };
  }) inventory.products
)
