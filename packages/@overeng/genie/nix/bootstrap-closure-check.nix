# Nix derivation that builds the standalone bootstrap-closure checker.
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
  git = pkgs.gitMinimal or pkgs.git;
  unwrapped = mkPnpmCli {
    name = "genie-bootstrap-closure-check-unwrapped";
    entry = "packages/@overeng/genie/bin/bootstrap-closure-check.ts";
    binaryName = "genie-bootstrap-closure-check";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = {
        hash = "sha256-+/J9pav88LNVFEYz1LtDMWppGyO/PscDQFG+vKZ/bXs=";
      };
    };
    generateCompletions = false;
    smokeTestArgs = [ "--help" ];
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "genie-bootstrap-closure-check"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "genie-bootstrap-closure-check";
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
    makeWrapper ${unwrapped}/bin/genie-bootstrap-closure-check $out/bin/genie-bootstrap-closure-check \
      --suffix PATH : ${git}/bin
  ''
