{ pkgs }:
let
  hashSource = "nix/cli-packages.nix";
  selectHashForSystem =
    hashes:
    if builtins.hasAttr pkgs.stdenv.hostPlatform.system hashes then
      hashes.${pkgs.stdenv.hostPlatform.system}
    else
      throw "Missing deps hash for system ${pkgs.stdenv.hostPlatform.system}";
  mkSharedHash = hash: {
    hash = selectHashForSystem {
      aarch64-darwin = hash;
      aarch64-linux = hash;
      x86_64-linux = hash;
    };
  };
in
{
  "megarepo-source-deps-support" = {
    inputName = "effect-utils";
    packageDir = "packages/@overeng/megarepo";
    builderFile = "flake.nix";
    inherit hashSource;
    metadataOnly = true;
    depsBuilds = {
      "." = mkSharedHash "sha256-5VjRvCd2FBN2KP3FSQ0AA2wUOlEWxuV09trURNzrMjI=";
    };
  };
}
