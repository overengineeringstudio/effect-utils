# CLI guard wrapper builder
#
# Creates shell scripts that intercept direct CLI invocations and
# print the canonical devenv task(s) instead. The real binary is
# reachable via DT_PASSTHROUGH=1 (set automatically by devenv env,
# dt wrapper, and CI).
#
# How passthrough works:
#   - devenv sets env.DT_PASSTHROUGH=1 (active during task execution)
#   - enterShell unsets it (so interactive shell usage hits guards)
#   - dt wrapper re-sets it before calling devenv tasks run
#   - CI helper (runDevenvTasksBefore) sets it
#
# Usage in task modules (Option A — derive guards from task defs):
#
#   let cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
#   in {
#     packages = cliGuard.fromTasks tasks;
#     tasks = cliGuard.stripGuards tasks;
#   }
#
#   where tasks have a `guard = "cli-name"` attribute on guarded entries.
#
# Low-level API (for cases where tasks aren't a plain attrset):
#
#   packages = [
#     (cliGuard.mkCliGuard {
#       cli = "oxlint";
#       tasks = [
#         { task = "lint:check:oxlint"; description = "Check lint"; }
#       ];
#     })
#   ];
{ pkgs }:
let
  # Build a single guard wrapper script for one CLI
  mkCliGuard =
    { cli, tasks }:
    let
      taskLines = builtins.concatStringsSep "\n" (
        map (
          t:
          let
            desc = if t ? description && t.description != null then "# ${t.description}\\n" else "";
          in
          ''printf "  ${desc}  devenv tasks run ${t.task} --mode before --no-tui\n\n" >&2''
        ) tasks
      );
    in
    pkgs.writeShellScriptBin cli ''
      set -euo pipefail

      if [ "''${DT_PASSTHROUGH:-}" = "1" ]; then
        _self="$(cd "''${0%/*}" && pwd -P)"
        _real=""
        IFS=: read -ra _dirs <<< "$PATH"
        for _d in "''${_dirs[@]}"; do
          [ -z "$_d" ] && continue
          _resolved="$(cd "$_d" 2>/dev/null && pwd -P)" || continue
          [ "$_resolved" = "$_self" ] && continue
          if [ -x "$_d/${cli}" ]; then
            _real="$_d/${cli}"
            break
          fi
        done
        if [ -z "$_real" ]; then
          echo "cli-guard: '${cli}' not found on PATH (after removing guard)" >&2
          exit 127
        fi
        exec "$_real" "$@"
      fi

      echo "" >&2
      echo "Instead of running '${cli}' directly, use the devenv task(s):" >&2
      echo "" >&2
      ${taskLines}
      echo "Run 'devenv tasks list' to see all available tasks." >&2
      echo "" >&2
      echo "Bypass (not recommended):" >&2
      echo "  DT_PASSTHROUGH=1 ${cli} $*" >&2
      echo "" >&2
      exit 1
    '';

  # Extract guard packages from a tasks attrset.
  # Tasks with a `guard = "cli-name"` attribute are grouped by CLI name
  # and a guard wrapper is generated for each group.
  fromTasks =
    tasks:
    let
      # Collect { cli, task, description } from tasks that have a guard attr
      guardEntries = builtins.filter (e: e != null) (
        builtins.attrValues (
          builtins.mapAttrs (
            name: def:
            if def ? guard then
              {
                # Normalize to a bare command name: strip context (so store-path strings
                # like "${pkgs.typescript}/bin/tsc" can be used as groupBy keys) and extract
                # the basename (so the wrapper is created as "tsc", not the full path).
                cli = builtins.unsafeDiscardStringContext (baseNameOf def.guard);
                task = name;
                description = def.description or null;
              }
            else
              null
          ) tasks
        )
      );

      # Group by CLI name
      cliNames = builtins.attrNames (builtins.groupBy (e: e.cli) guardEntries);

      mkGuardForCli =
        cli:
        let
          entries = builtins.filter (e: e.cli == cli) guardEntries;
        in
        mkCliGuard {
          inherit cli;
          tasks = map (e: { inherit (e) task description; }) entries;
        };
    in
    map mkGuardForCli cliNames;

  # Strip the `guard` attribute from all tasks in an attrset.
  # Use this before passing tasks to devenv (which doesn't know about `guard`).
  stripGuards = builtins.mapAttrs (_: def: builtins.removeAttrs def [ "guard" ]);

in
{
  inherit mkCliGuard fromTasks stripGuards;
}
