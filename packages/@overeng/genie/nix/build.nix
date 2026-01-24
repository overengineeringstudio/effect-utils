# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
#
# Fallback pattern: oxfmt is appended to PATH via --suffix, so system oxfmt
# takes precedence when available, but bundled oxfmt is used as fallback.
# This avoids formatting churn when oxfmt isn't installed in the environment.
{ pkgs, src, gitRev ? "unknown", dirty ? false }:

let
  mkBunCli = import ../../../../nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs; };

  unwrapped = mkBunCli {
    name = "genie-unwrapped";
    entry = "packages/@overeng/genie/src/build/mod.ts";
    binaryName = "genie";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    extraExcludedSourceNames = [ "context" "scripts" ];
    typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
    depsManager = "pnpm";
    pnpmDepsHash = "sha256-WY4PyjBPt57C6c8BC0TI5Etn4kzk7wefzjs4qZShZ6o=";
    dirty = dirty;
    inherit gitRev;
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
