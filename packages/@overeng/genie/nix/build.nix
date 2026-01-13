# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, gitRev ? "unknown" }:

let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };
in
mkBunCli {
  name = "genie";
  entry = "packages/@overeng/genie/src/build/cli.ts";
  binaryName = "genie";
  packageDir = "packages/@overeng/genie";
  workspaceRoot = src;
  typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
  bunDepsHash = "sha256-WLkR7X5stKcFbroEflzIvcWDhVWsHxsNtsZZEAnAjBo=";
  inherit gitRev;
}
