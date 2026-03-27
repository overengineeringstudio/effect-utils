# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
#
# Fallback pattern: oxfmt is appended to PATH via --suffix, so system oxfmt
# takes precedence when available, but bundled oxfmt is used as fallback.
# This avoids formatting churn when oxfmt isn't installed in the environment.
{
  pkgs,
  src,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
}:

let
  pnpm = import ../../../../nix/pnpm.nix { inherit pkgs; };
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs pnpm; };
  # Managed by `nix-hash-refresh --name genie`. This caches the builder-owned deps recipe
  # fingerprint so quick checks can compare against the actual deps contract.
  depsBuildFingerprint = "8e13c3c91439bd89f4f14fde4bc60c023575cadea3e5d71068fcfdaf1155e166";
  unwrapped = mkPnpmCli {
    name = "genie-unwrapped";
    entry = "packages/@overeng/genie/bin/genie.tsx";
    binaryName = "genie";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    # Managed by `nix-hash-refresh --name genie` — do not edit manually.
    pnpmDepsHash = "sha256-JQSV+QfJnK0joP2dDL8+rAbUnb4Nx1wNa0UaGeA9Hdk=";
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "genie"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "genie";
    passthru = {
      # Keep the prepared pnpm deps reachable from the wrapped CLI too so flake
      # consumers and hash tooling can target one stable attribute path.
      inherit (unwrapped.passthru) pnpmDeps depsBuildFingerprint;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/genie $out/bin/genie \
      --suffix PATH : ${pkgs.oxfmt}/bin
  ''
