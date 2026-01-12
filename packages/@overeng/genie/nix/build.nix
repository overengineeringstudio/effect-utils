# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown" }:

let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable src; };
in
mkBunCli {
  name = "genie";
  entry = "effect-utils/packages/@overeng/genie/src/build/cli.ts";
  binaryName = "genie";
  packageJsonPath = "effect-utils/packages/@overeng/genie/package.json";
  typecheckTsconfig = "effect-utils/packages/@overeng/genie/tsconfig.json";
  sources = [
    { name = "effect-utils"; src = src; }
  ];
  installDirs = [
    "effect-utils/packages/@overeng/genie"
    "effect-utils/packages/@overeng/utils"
  ];
  bunDepsHash = "sha256-vDgqQQxEi2VfykKwPfDI1Lv5hPQz+7rvW3CPm+PhX+I=";
  inherit gitRev;
}
