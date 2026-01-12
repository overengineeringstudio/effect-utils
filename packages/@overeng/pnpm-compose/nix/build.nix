# Nix derivation that builds pnpm-compose CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown" }:

let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable src; };
in
mkBunCli {
  name = "pnpm-compose";
  entry = "effect-utils/packages/@overeng/pnpm-compose/src/cli.ts";
  binaryName = "pnpm-compose";
  packageJsonPath = "effect-utils/packages/@overeng/pnpm-compose/package.json";
  typecheckTsconfig = "effect-utils/packages/@overeng/pnpm-compose/tsconfig.json";
  sources = [
    { name = "effect-utils"; src = src; }
  ];
  installDirs = [
    "effect-utils/packages/@overeng/pnpm-compose"
    "effect-utils/packages/@overeng/utils"
  ];
  bunDepsHash = "sha256-JtxYAEufsrrbYZA5OdZzaWRpgvawnOMwmht+98DDHSQ=";
  inherit gitRev;
}
