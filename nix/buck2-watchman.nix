# Worktree-owned Watchman: never connect to, stop, or configure a user daemon.
{
  buck2,
  capabilities,
}:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  root = config.devenv.root;
  trace = import ./devenv-modules/tasks/lib/trace.nix { inherit lib; };
  # A short path fits Darwin's Unix socket limit even for deeply nested worktrees.
  identity = builtins.substring 0 24 (builtins.hashString "sha256" root);
  state = "/tmp/effect-utils-watchman-${identity}";
  socket = "${state}/socket";
  globalConfig = pkgs.writeText "effect-utils-watchman.json" ''
    {"min_acceptable_nice_value":19}
  '';
  watchman = "${pkgs.watchman}/bin/watchman";
  start = pkgs.writeShellScript "effect-utils-watchman-start" ''
    set -euo pipefail
    umask 077
    if ! ${pkgs.coreutils}/bin/mkdir -m 700 ${state} 2>/dev/null; then
      if [ -L ${state} ] || [ ! -d ${state} ] || [ ! -O ${state} ]; then
        echo "Refusing unowned Watchman state directory: ${state}" >&2
        exit 1
      fi
    fi
    ${pkgs.coreutils}/bin/chmod 700 ${state}
    export WATCHMAN_CONFIG_FILE=${globalConfig}
    ${watchman} --sockname=${socket} --statefile=${state}/state \
      --logfile=${state}/log --pidfile=${state}/pid --no-site-spawner get-sockname
  '';
  refresh = pkgs.writeShellScript "effect-utils-capabilities-refresh" ''
    set -euo pipefail
    cd ${lib.escapeShellArg root}
    ${pkgs.coreutils}/bin/mkdir -p .buck2
    exec 9>.buck2/capabilities.lock
    ${pkgs.flock}/bin/flock 9
    if [ "$(${pkgs.coreutils}/bin/readlink .buck2/capabilities || true)" != ${capabilities} ]; then
      # Buck caches external-cell roots: watching the link cannot retarget a warm daemon.
      ${buck2}/bin/buck2 kill
      if [ -e .buck2/capabilities ] && [ ! -L .buck2/capabilities ]; then
        ${pkgs.coreutils}/bin/rm -rf -- .buck2/capabilities
      fi
      candidate=".buck2/capabilities.candidate.$$"
      trap '${pkgs.coreutils}/bin/rm -f -- "$candidate"' EXIT
      ${pkgs.coreutils}/bin/ln -s ${capabilities} "$candidate"
      ${pkgs.coreutils}/bin/mv -Tf "$candidate" .buck2/capabilities
    fi
  '';
in
{
  env.WATCHMAN_SOCK = socket;
  env.WATCHMAN_CONFIG_FILE = "${globalConfig}";

  tasks."buck2:watchman:start" = {
    description = "Start or reuse this worktree's owned Watchman daemon (nice 19 allowed)";
    exec = trace.exec "buck2:watchman:start" "${start}";
  };
  tasks."buck2:watchman:stop" = {
    description = "Stop this worktree's Buck and Watchman daemons only";
    exec = trace.exec "buck2:watchman:stop" ''
      set -euo pipefail
      cd ${lib.escapeShellArg root}
      ${buck2}/bin/buck2 kill
      if [ -L ${state} ] || { [ -e ${state} ] && [ ! -O ${state} ]; }; then
        echo "Refusing unowned Watchman state directory: ${state}" >&2
        exit 1
      fi
      if [ -S ${socket} ]; then
        ${watchman} --sockname=${socket} --no-spawn shutdown-server
      fi
    '';
  };
  tasks."buck2:capabilities:refresh" = {
    description = "Refresh the Nix capability generation, restarting Buck when it changes";
    after = [ "buck2:watchman:start" ];
    # Plain task runs, not just shell entry, must cross the generation boundary.
    before = [
      "devenv:enterShell"
    ]
    ++ lib.filter (
      name:
      name != "buck2:capabilities:refresh"
      && name != "buck2:watchman:start"
      && name != "buck2:watchman:stop"
      && (
        lib.hasPrefix "buck2:" name
        || (config.tasks.${name}.exec != null && lib.hasInfix "$BUCK2_BIN" config.tasks.${name}.exec)
      )
    ) (builtins.attrNames config.tasks);
    exec = trace.exec "buck2:capabilities:refresh" "${refresh}";
  };
}
