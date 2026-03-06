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
    # Patches referenced in pnpm-workspace.yaml (shared across all workspaces)
    patchesDir = "packages/@overeng/utils/patches";
    # Managed by `dt nix:hash:genie` — do not edit manually.
    pnpmDepsHash = "sha256-0OSGcThI7Q9YhYLhNmTpobn7/2IYnDg0ejmisZcaoSQ=";
    lockfileHash = "sha256-A8axH5fMO9VA3l9Sh68TdphefBGhcovgUwwy1tentsI=";
    packageJsonDepsHash = "sha256-tMch41qH+GilQSbIGitAHjKtPH2tb4h9uSwDW1peQDc=";
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
