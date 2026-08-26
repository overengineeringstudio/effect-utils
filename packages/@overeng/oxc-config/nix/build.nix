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
    "." = mkSharedHash "sha256-YZS3UJM032/MJoq9qahHpVD0cbHFXiSex6WoGLO6jho=";
  };
  hashSourcePath = "packages/@overeng/oxc-config/nix/build.nix";
}
