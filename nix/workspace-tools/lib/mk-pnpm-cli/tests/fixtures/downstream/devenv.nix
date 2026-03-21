{ pkgs, inputs, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
  effectUtilsPackages = inputs.effect-utils.packages.${system};
in
{
  packages = [
    effectUtilsPackages.megarepo
    effectUtilsPackages.genie
    effectUtilsPackages.oxlint-npm
  ];
}
