# Nix derivation that builds the mono CLI binary.
# Uses bun build --compile for native platform.
{ pkgs, pkgsUnstable, src, mkBunCli ? null, gitRev ? "unknown" }:

let
  mkBunCliResolved =
    if mkBunCli != null
    then mkBunCli
    else import ../../nix/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };
in
mkBunCliResolved {
  name = "mono";
  entry = "scripts/mono.ts";
  binaryName = "mono";
  packageDir = "scripts";
  workspaceRoot = src;
  extraExcludedSourceNames = [ "context" ];
  typecheckTsconfig = "scripts/tsconfig.json";
  bunDepsHash = "sha256-xIKojRtLkhmxLj3u7kobCJDSj8d5abT7bSn0FpBEU3Y=";
  dirty = true;
  inherit gitRev;
}
