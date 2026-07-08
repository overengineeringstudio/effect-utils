# Nix derivation that builds the narrow Genie bootstrap runner.
#
# This is intentionally separate from the user-facing `genie` CLI. The runner is
# the cold-proof artifact for pre-install bootstrap generation, so it does not
# carry the TUI/telemetry/Effect CLI entrypoint or an installed source workspace.
{
  pkgs,
  src,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
  typeProofCompilerBin,
}:

let
  pnpm = import ../../../../nix/pnpm.nix { inherit pkgs; };
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs pnpm; };
  unwrapped = mkPnpmCli {
    name = "genie-bootstrap-runner-unwrapped";
    entry = "packages/@overeng/genie/bin/genie-bootstrap-runner.ts";
    binaryName = "genie-bootstrap-runner";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = {
        hash = "sha256-+/J9pav88LNVFEYz1LtDMWppGyO/PscDQFG+vKZ/bXs=";
      };
    };
    smokeTestArgs = [ "--help" ];
    generateCompletions = false;
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "genie-bootstrap-runner"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "genie-bootstrap-runner";
    passthru = {
      inherit (unwrapped.passthru)
        depsBuildEntries
        depsBuildsByInstallRoot
        fodHashRepairTargets
        inheritRootPatchedDependenciesScript
        installRoots
        ;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/genie-bootstrap-runner $out/bin/genie-bootstrap-runner \
      --suffix PATH : ${pkgs.oxfmt}/bin \
      --set GENIE_ACTIONLINT_BIN ${pkgs.actionlint}/bin/actionlint \
      --set GENIE_EXPORT_TYPE_PROOF_COMPILER ${typeProofCompilerBin}
  ''
