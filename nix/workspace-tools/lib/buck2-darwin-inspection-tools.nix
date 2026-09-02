{ pkgs }:

let
  inherit (pkgs.darwin) cctools;
in
assert pkgs.lib.assertMsg pkgs.stdenv.hostPlatform.isDarwin
  "buck2-darwin-inspection-tools requires a Darwin Nix realization";
{
  otool = {
    identity = toString cctools;
    executable = "${cctools}/bin/otool";
  };
  lipo = {
    identity = toString cctools;
    executable = "${cctools}/bin/lipo";
  };
}
