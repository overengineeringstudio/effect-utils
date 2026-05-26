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
  opentuiCoreNative = import ../../../../nix/opentui-core-native.nix { inherit pkgs; };
  unwrapped = mkPnpmCli {
    name = "notion-cli-unwrapped";
    entry = "packages/@overeng/notion-cli/src/cli.ts";
    binaryName = "notion";
    packageDir = "packages/@overeng/notion-cli";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = {
        hash = "sha256-VrpW4MT6ZDqpsE7Utu/CXXA1UOSJsD+HDHXEPZ/lp9g=";
      };
    };
    nativeNodePackages = [ opentuiCoreNative ];
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
