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
  mkHash = hashes: {
    hash = hashes.${pkgs.stdenv.hostPlatform.system} or hashes.x86_64-linux;
  };
  opentuiCoreNative = import ../../../../nix/opentui-core-native.nix { inherit pkgs; };
  unwrapped = mkPnpmCli {
    name = "tui-stories-unwrapped";
    entry = "packages/@overeng/tui-stories/bin/tui-stories.tsx";
    binaryName = "tui-stories";
    packageDir = "packages/@overeng/tui-stories";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = mkHash {
        aarch64-darwin = "sha256-WWN13PiC46GMSZACKIj8xw8lK9xOL3niiz81T9+Pqiw=";
        aarch64-linux = "sha256-5dKEz+N4pQWZTXafOFOp7qTHntSQN6dGI6Q6eKJKOrQ=";
        x86_64-linux = "sha256-5dKEz+N4pQWZTXafOFOp7qTHntSQN6dGI6Q6eKJKOrQ=";
      };
    };
    nativeNodePackages = opentuiCoreNative.packages;
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "tui-stories"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "tui-stories";
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
    makeWrapper ${unwrapped}/bin/tui-stories $out/bin/tui-stories
  ''
