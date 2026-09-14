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
    "." = mkSharedHash "sha256-0KW9XRnBr9XjmQSx9W5PRLf8JNCMc1oOBOujNMhJ/+c=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
