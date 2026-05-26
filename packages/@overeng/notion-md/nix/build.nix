# Nix derivation that builds notion-md CLI binary.
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
    name = "notion-md-unwrapped";
    entry = "packages/@overeng/notion-md/src/cli.ts";
    binaryName = "notion-md";
    packageDir = "packages/@overeng/notion-md";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = {
        hash = "sha256-2TwKDZskgYdaUiGC6PUh9jfP3YjydNSF/jE42M3/xM4=";
      };
    };
    smokeTestArgs = [ "--help" ];
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "notion-md"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "notion-md";
    passthru = {
      inherit (unwrapped.passthru) depsBuildEntries depsBuildsByInstallRoot installRoots;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/notion-md $out/bin/notion-md
  ''
