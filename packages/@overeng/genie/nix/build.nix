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
    # Managed by `dt nix:hash:genie` — do not edit manually.
    pnpmDepsHash = "sha256-fuvycq5/nEhtAmkq53irp+Tb8C/HpMiqRpo/6/7GKIs=";
    lockfileHash = "sha256-SeUHC5ufYtN7P7lvrouN2axYwtuhm5Y0ERt5IuqJBnQ=";
    packageJsonDepsHash = "sha256-3Wt/K6hl0Sv9/imzboMh2I7nHvxOMmnl3T/cTJCUH08=";
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
