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
    "." = mkSharedHash "sha256-B+VmTr9kVUpq3HKfK5L9ELA5i6Vpm+JE4H8Zj2J/iRU=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
