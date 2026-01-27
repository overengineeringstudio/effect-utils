# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
#
# Fallback pattern: oxfmt is appended to PATH via --suffix, so system oxfmt
# takes precedence when available, but bundled oxfmt is used as fallback.
# This avoids formatting churn when oxfmt isn't installed in the environment.
{ pkgs, src, gitRev ? "unknown", commitTs ? 0, dirty ? false }:

let
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs; };

  unwrapped = mkPnpmCli {
    name = "genie-unwrapped";
    entry = "packages/@overeng/genie/src/build/mod.ts";
    binaryName = "genie";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    extraExcludedSourceNames = [ "context" "scripts" ];
    pnpmDepsHash = "sha256-UHz5JLKnlPObFn9p21sA0Gq8lvilQl33S3mH6mkMQ94=";
    localDeps = [
      { dir = "packages/@overeng/utils"; hash = "sha256-MycpokWA4roGBELpRdj5CXjRdPcboktPBLoVWP55rJI="; }
    ];
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "genie" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  meta.mainProgram = "genie";
} ''
  mkdir -p $out/bin
  makeWrapper ${unwrapped}/bin/genie $out/bin/genie \
    --suffix PATH : ${pkgs.oxfmt}/bin
''
