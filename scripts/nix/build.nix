# Nix derivation that builds the mono CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, src, mkBunCli ? null, gitRev ? "unknown", dirty ? false }:

let
  mkBunCliResolved =
    if mkBunCli != null
    then mkBunCli
    else import ../../nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs; };
in
mkBunCliResolved {
  name = "mono";
  entry = "scripts/mono.ts";
  binaryName = "mono";
  packageDir = "scripts";
  workspaceRoot = src;
  extraExcludedSourceNames = [ "context" ];
  typecheckTsconfig = "scripts/tsconfig.json";
  depsManager = "pnpm";
  pnpmDepsHash = "sha256-GvuTWUH0NOoX/YjRmtMIW5o7beZhD4u4bbL3B7ch1I4=";
  dirty = dirty;
  inherit gitRev;
}
