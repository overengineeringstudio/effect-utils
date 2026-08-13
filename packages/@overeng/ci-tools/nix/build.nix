# Nix derivation that builds the ci-tools CLI binary.
{
  pkgs,
  src,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
}:

let
  mkHash = hashes: {
    hash =
      hashes.${pkgs.stdenv.hostPlatform.system}
        or (throw "ci-tools has no dependency snapshot for ${pkgs.stdenv.hostPlatform.system}");
  };
  pnpm = import ../../../../nix/pnpm.nix { inherit pkgs; };
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs pnpm; };
  unwrapped = mkPnpmCli {
    name = "ci-tools-unwrapped";
    entry = "packages/@overeng/ci-tools/bin/ci-tools.ts";
    binaryName = "ci-tools";
    packageDir = "packages/@overeng/ci-tools";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = mkHash {
        aarch64-darwin = "sha256-zjgi48BGIV6BxsaTfyJhP0jHvmyzPldvSTvU2Q2FvU8=";
        aarch64-linux = "sha256-Dzxg2BYFIKzeovpHnAdMGG6qO1InF2YOLEKqjDfqqqY=";
        x86_64-linux = "sha256-zjgi48BGIV6BxsaTfyJhP0jHvmyzPldvSTvU2Q2FvU8=";
      };
    };
    smokeTestArgs = [ "--help" ];
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "ci-tools"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "ci-tools";
    passthru = {
      inherit (unwrapped.passthru)
        depsBuildEntries
        depsBuildsByInstallRoot
        fodHashRepairTargets
        installRoots
        ;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/ci-tools $out/bin/ci-tools
  ''
