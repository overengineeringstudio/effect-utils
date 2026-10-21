# One storage-selection prologue for installs and frozen lockfile verification.
{
  lib,
  pkgs,
  config,
  workspaceRoot ? ".",
  globalVirtualStore ? false,
}:
let
  workspaceCacheName = builtins.replaceStrings [ "/" "." ] [ "-" "_" ] workspaceRoot;
  workspaceRootAbs =
    if workspaceRoot == "." then config.devenv.root else "${config.devenv.root}/${workspaceRoot}";
  jobLocalPnpmStoreDir =
    "${config.devenv.root}/.devenv/pnpm-store-pure-v1"
    + lib.optionalString (workspaceRoot != ".") "/${workspaceCacheName}";
in
{
  helpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ../shared/pnpm-task-helpers.sh
  );
  configure = ''
    configure_pnpm_storage \
      ${lib.escapeShellArg "${pkgs.nodejs}/bin/node"} \
      ${lib.escapeShellArg workspaceRootAbs} \
      ${lib.escapeShellArg jobLocalPnpmStoreDir} \
      ${lib.boolToString pkgs.stdenv.hostPlatform.isLinux} \
      ${lib.boolToString globalVirtualStore}
  '';
}
