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
    pnpmDepsHash = "sha256-v2PHaOFuQjJd2xr5rggqK2XYyvbVHunm4cLbq5C3LPc=";
    lockfileHash = "sha256-rDd8rCugLcIud9s3WWx//IdhRk9E6VQ/aWogSY0lXjo=";
    packageJsonDepsHash = "sha256-R6bwntBv6ebtY4kaE1mrc1yACPZU+OQXp5rs7Pwj/h4=";
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
