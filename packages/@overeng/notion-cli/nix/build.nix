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
  nodejs = pkgs.nodejs_24 or pkgs.nodejs;
  unwrapped = mkPnpmCli {
    name = "notion-cli-unwrapped";
    entry = "packages/@overeng/notion-cli/src/cli.ts";
    binaryName = "notion";
    packageDir = "packages/@overeng/notion-cli";
    workspaceRoot = src;
    smokeTestArgs = [
      "md"
      "--help"
    ];
    installRuntimeWorkspace = true;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = {
        hash = "sha256-FesW+wcsTSBviQMSpsqnl9mvXnxhuSZNMNXIQCsSk3c=";
      };
    };
    nativeNodePackages = [ opentuiCoreNative ];
    inherit gitRev commitTs dirty;
  };
  datasourceSyncRuntime = pkgs.writeShellScriptBin "notion-datasource-sync" ''
    exec ${nodejs}/bin/node ${unwrapped}/libexec/workspace/packages/@overeng/notion-datasource-sync/src/cli/main.ts "$@"
  '';
in
pkgs.runCommand "notion-cli"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "notion";
    passthru = {
      inherit (unwrapped.passthru) depsBuildEntries depsBuildsByInstallRoot installRoots;
      inherit datasourceSyncRuntime;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/notion $out/bin/notion \
      --run 'if [ "$#" -gt 0 ] && [ "$1" = sqlite ]; then shift; exec ${datasourceSyncRuntime}/bin/notion-datasource-sync "$@"; fi'

    sqlite_output="$($out/bin/notion sqlite 2>&1 || true)"
    if ! printf '%s\n' "$sqlite_output" | grep -q 'Expected one of: init, pull, push, sync, status'; then
      printf '%s\n' "$sqlite_output" >&2
      echo "notion sqlite smoke test failed" >&2
      exit 1
    fi
  ''
