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
    "." = mkSharedHash "sha256-6SEN0n+siabEiBKaH7R+5Smq654PIyVWdX0kYXRsvf8=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
