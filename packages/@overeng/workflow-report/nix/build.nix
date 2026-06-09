# Nix derivation that builds the workflow-report CLI binary.
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
  unwrapped = mkPnpmCli {
    name = "workflow-report-unwrapped";
    entry = "packages/@overeng/workflow-report/bin/workflow-report.ts";
    binaryName = "workflow-report";
    packageDir = "packages/@overeng/workflow-report";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = {
        hash = "sha256-XGspSEDxjipfksN+M5Mx2iFNdLfceKhB/s9ij1z7E3U=";
      };
    };
    smokeTestArgs = [ "--help" ];
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "workflow-report"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "workflow-report";
    passthru = {
      inherit (unwrapped.passthru) depsBuildEntries depsBuildsByInstallRoot installRoots;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/workflow-report $out/bin/workflow-report
  ''
