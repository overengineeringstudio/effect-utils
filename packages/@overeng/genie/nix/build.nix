# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown" }:

let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable src; };
in
mkBunCli {
  name = "genie";
  entry = "packages/@overeng/genie/src/cli.ts";
  binaryName = "genie";
  packageJsonPath = "packages/@overeng/genie/package.json";
  typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
  bunDepsHash = "sha256-JtxYAEufsrrbYZA5OdZzaWRpgvawnOMwmht+98DDHSQ=";
  workspaceDeps = [
    { name = "@overeng/utils"; path = "packages/@overeng/utils"; }
  ];
  inherit gitRev;
}
