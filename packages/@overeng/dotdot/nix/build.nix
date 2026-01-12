# Nix derivation that builds dotdot CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown" }:

let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable src; };
in
mkBunCli {
  name = "dotdot";
  entry = "effect-utils/packages/@overeng/dotdot/src/cli.ts";
  binaryName = "dotdot";
  packageJsonPath = "effect-utils/packages/@overeng/dotdot/package.json";
  typecheckTsconfig = "effect-utils/packages/@overeng/dotdot/tsconfig.json";
  sources = [
    { name = "effect-utils"; src = src; }
  ];
  installDirs = [
    "effect-utils/packages/@overeng/dotdot"
    "effect-utils/packages/@overeng/utils"
  ];
  bunDepsHash = "sha256-VGMmRFaJPhXOEI4nAwGHHU+McNwkz7zXc2FUyIit58k=";
  inherit gitRev;
}
