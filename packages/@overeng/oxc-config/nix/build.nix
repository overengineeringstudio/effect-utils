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
    "." = mkSharedHash "sha256-iskCQQJYzuXg0mL3k+CIlAp8T9hDfFrGuTH72Gpdzww=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
