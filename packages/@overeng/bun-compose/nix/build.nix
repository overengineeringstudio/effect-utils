# Nix derivation that builds bun-compose CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown" }:

let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable src; };
in
mkBunCli {
  name = "bun-compose";
  entry = "packages/@overeng/bun-compose/src/cli.ts";
  binaryName = "bun-compose";
  packageJsonPath = "packages/@overeng/bun-compose/package.json";
  typecheckTsconfig = "packages/@overeng/bun-compose/tsconfig.json";
  bunDepsHash = "sha256-w/fwaMErKoSGw43ZNA6FvgzNKHm/zli4qqSRj0L+wCc=";
  inherit gitRev;
}
