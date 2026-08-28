{
  pkgs,
  bun,
  src,
}:
let
  mkSharedHash = hash: { inherit hash; };
in
import ../../../../nix/oxc-config-plugin.nix {
  inherit
    pkgs
    bun
    src
    ;
  # Managed by Evergreen FOD refresh — do not edit manually.
  depsBuilds = {
    "." = mkSharedHash "sha256-zgUw4TJwBFSmibCzGtc/ar7uM2UTly9KmhGch5kRP2I=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
