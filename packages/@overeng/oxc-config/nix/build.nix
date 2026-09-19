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
    "." = mkSharedHash "sha256-OTYWDbTbIa86Apeuq17BE1wOpHMTzDTSaOM/wIxGtZk=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
