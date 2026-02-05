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
    entry = "packages/@overeng/genie/bin/genie.tsx";
    binaryName = "genie";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    extraExcludedSourceNames = [ "context" "scripts" ];
    # Platform-independent hash: pnpm-workspace.yaml has supportedArchitectures configured
    # to download binaries for all platforms (linux/darwin x x64/arm64), so the hash is
    # the same regardless of where the build runs.
    pnpmDepsHash = "sha256-RVbdCRnWYxoDip1R3AiPuLm/CF7ZIqotNAKcLyAvkbs=";
    lockfileHash = "sha256-jYIRxXlmlMW305bGUYJyzcVqf/ZaaBVrYDqdCeMBQUc=";
    packageJsonDepsHash = "sha256-vGC5f0D1JP3TyazuWez475pUTd4XD/slhT89ybmI0Cs=";
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
