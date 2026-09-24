# Load only the reviewed Cachix product manifest.
{
  pkgs,
  fromSourceProducts,
}:
import ./cache.nix { inherit pkgs fromSourceProducts; }
