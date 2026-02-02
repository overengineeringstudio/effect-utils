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
    # Workspace members from pnpm-workspace.yaml (relative paths resolved to absolute)
    # Their package.json files are included in fetchPnpmDeps source so pnpm fetches their deps
    workspaceMembers = [
      "packages/@overeng/tui-core"
      "packages/@overeng/tui-react"
      "packages/@overeng/utils"
    ];
    # Platform-specific hash: fetchPnpmDeps only fetches native binaries for the current platform.
    # Each platform produces different hashes due to platform-specific optional dependencies
    # (e.g., @esbuild/darwin-arm64 vs @esbuild/linux-x64).
    # Platform-specific hash: pnpm fetches different platform-specific native binaries
    pnpmDepsHash = if pkgs.stdenv.isDarwin
      then "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="  # TODO: get Darwin hash
      else "sha256-0OHMzQED/RhUu53PzfxvTnveqewCZgphJasIJXyrPSc=";
    lockfileHash = "sha256-QGGaglW35zh/PsdeAgHchf83RSDgQLUL7y25aXlz5bI=";
    packageJsonDepsHash = "sha256-slNo40B9ZwvVopL7htF9m0Skywj5G8zVhlAZbE/lCHM=";
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
