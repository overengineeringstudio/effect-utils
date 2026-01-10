# Nix derivation that builds pnpm-compose CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown" }:

let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable src; };
in
mkBunCli {
  name = "pnpm-compose";
  entry = "packages/@overeng/pnpm-compose/src/cli.ts";
  binaryName = "pnpm-compose";
  packageJsonPath = "packages/@overeng/pnpm-compose/package.json";
  typecheckTsconfig = "packages/@overeng/pnpm-compose/tsconfig.json";
  bunDepsHash = "sha256-JtxYAEufsrrbYZA5OdZzaWRpgvawnOMwmht+98DDHSQ=";
  workspaceDeps = [
    { name = "@overeng/utils"; path = "packages/@overeng/utils"; }
  ];
  inherit gitRev;
}
