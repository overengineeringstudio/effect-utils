# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown", dirty ? false }:

let
  mkBunCli = import ../../../../nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };
in
mkBunCli {
  name = "genie";
  entry = "packages/@overeng/genie/src/build/mod.ts";
  binaryName = "genie";
  packageDir = "packages/@overeng/genie";
  workspaceRoot = src;
  extraExcludedSourceNames = [ "context" "scripts" ];
  typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
  bunDepsHash = "sha256-Nqe84jfMDBea3KE3S+1BV70DiwZbnQ2StS8fSckNy5c=";
  dirty = dirty;
  inherit gitRev;
}
