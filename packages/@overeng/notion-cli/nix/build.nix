# Nix derivation that builds notion CLI binary.
# Uses bun build --compile for native platform.
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
    name = "notion-cli-unwrapped";
    entry = "packages/@overeng/notion-cli/src/cli.ts";
    binaryName = "notion";
    packageDir = "packages/@overeng/notion-cli";
    workspaceRoot = src;
    # Managed by `dt nix:hash:notion-cli` — do not edit manually.
    depsBuilds = {
      "." = {
        hash = "sha256-+4uvdGZjB6vijG415O6WoU1sSz29XUAKanHvLz2HPzc=";
      };
    };
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "notion-cli"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "notion";
    passthru = {
      inherit (unwrapped.passthru) depsBuildEntries depsBuildsByInstallRoot installRoots;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/notion $out/bin/notion
  ''
