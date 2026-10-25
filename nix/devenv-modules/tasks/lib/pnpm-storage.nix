# One storage-selection prologue for installs and frozen lockfile verification.
{
  lib,
  pkgs,
  config,
  workspaceRoot ? ".",
  globalVirtualStore ? false,
  installFlags ? [ ],
  pnpmPkg ? null,
}:
let
  cliGuard = import ./cli-guard.nix { inherit pkgs; };
  workspaceCacheName = builtins.replaceStrings [ "/" "." ] [ "-" "_" ] workspaceRoot;
  cache = import ./cache.nix { inherit config; };
  cacheRoot = cache.mkCachePath (
    "pnpm-install" + lib.optionalString (workspaceRoot != ".") "/${workspaceCacheName}"
  );
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
  acquireRootLock = ''
    acquire_pnpm_materialization_root_lock \
      ${lib.escapeShellArg "${pkgs.flock}/bin/flock"} \
      ${lib.escapeShellArg "${cacheRoot}/pnpm-install.lock"} \
      600
  '';
  configure = ''
    ${cliGuard.resolveCliBin {
      cli = "pnpm";
      realBin = pnpmPkg;
    }}
    PNPM_NATIVE_BIN="$_real"
    configure_pnpm_storage \
      ${lib.escapeShellArg "${pkgs.nodejs}/bin/node"} \
      ${lib.escapeShellArg workspaceRootAbs} \
      ${lib.escapeShellArg jobLocalPnpmStoreDir} \
      ${lib.boolToString pkgs.stdenv.hostPlatform.isLinux} \
      ${lib.boolToString globalVirtualStore} \
      "$PNPM_NATIVE_BIN" \
      ${lib.escapeShellArgs installFlags}
  '';
}
