# Nix derivation that builds tui-stories CLI binary.
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
    name = "tui-stories-unwrapped";
    entry = "packages/@overeng/tui-stories/bin/tui-stories.tsx";
    binaryName = "tui-stories";
    packageDir = "packages/@overeng/tui-stories";
    workspaceRoot = src;
    # Managed by `dt nix:hash:tui-stories` — do not edit manually.
    depsBuilds = {
      "." = {
        hash = "sha256-55Vu8c5Orah/V5WOz6dJZ4e69Wp2xYCu0zxO8lTnyUI=";
      };
    };
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "tui-stories"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "tui-stories";
    passthru = {
      inherit (unwrapped.passthru) depsBuildEntries depsBuildsByInstallRoot installRoots;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/tui-stories $out/bin/tui-stories
  ''
