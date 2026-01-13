# Nix derivation that builds dotdot CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown" }:

let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };
in
mkBunCli {
  name = "dotdot";
  entry = "packages/@overeng/dotdot/src/cli.ts";
  binaryName = "dotdot";
  packageDir = "packages/@overeng/dotdot";
  workspaceRoot = src;
  typecheckTsconfig = "packages/@overeng/dotdot/tsconfig.json";
  bunDepsHash = "sha256-0HfezPxkSbXI4+0sLjhZ4u44j7nIp/25zRXRXRxPaSM=";
  inherit gitRev;
}
