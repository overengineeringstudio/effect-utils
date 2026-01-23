# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, src, gitRev ? "unknown", dirty ? false }:

let
  mkBunCli = import ../../../../nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs; };
in
mkBunCli {
  name = "genie";
  entry = "packages/@overeng/genie/src/build/mod.ts";
  binaryName = "genie";
  packageDir = "packages/@overeng/genie";
  workspaceRoot = src;
  extraExcludedSourceNames = [ "context" "scripts" ];
  typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
  bunDepsHash = "sha256-qejMQMUL17HoLSMG9Q21QHCxJ+Q0mevYf552ed/MulU=";
  dirty = dirty;
  inherit gitRev;
}
