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
  # TODO: lockfileHash oscillates due to circular dependency between build.nix
  # content and staged lockfile hash. Disabled until mk-pnpm-cli lockfile hashing
  # is updated to exclude build.nix from the staged source.
  lockfileHash = null;
  packageJsonDepsHash = "sha256-W72mXuz+mfV0fYzKVauO10NjHtT1BdTU8ODvh1uqNZ4=";
  unwrapped = mkPnpmCli {
    name = "genie-unwrapped";
    entry = "packages/@overeng/genie/bin/genie.tsx";
    binaryName = "genie";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    # Managed by `dt nix:hash:genie` — do not edit manually.
    pnpmDepsHash = "sha256-79S9YfMRm7r6Dr30ywfwiVgZbOKPT05EZH/WkOStTwk=";
    inherit
      lockfileHash
      gitRev
      commitTs
      dirty
      ;
  };
in
pkgs.runCommand "genie"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "genie";
    passthru = {
      # Keep the prepared pnpm deps reachable from the wrapped CLI too so flake
      # consumers and hash tooling can target one stable attribute path.
      inherit (unwrapped.passthru) pnpmDeps;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/genie $out/bin/genie \
      --suffix PATH : ${pkgs.oxfmt}/bin
  ''
