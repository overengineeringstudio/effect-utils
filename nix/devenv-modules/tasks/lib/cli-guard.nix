# CLI guard wrapper builder
#
# Creates shell scripts that intercept direct CLI invocations and
# print the canonical devenv task(s) instead. The real binary is
# reachable via DEVENV_TASK_PASSTHROUGH=1 (set automatically by task env
# and CI).
#
# How passthrough works:
#   - stripGuards sets per-task env.DEVENV_TASK_PASSTHROUGH=1 on all tasks
#   - enterShell unsets it (so interactive shell usage hits guards)
#   - CI helper (runDevenvTasksBefore) sets it
#
# Ownership and the `realBin` arg:
#   A guard wrapper is itself a `writeShellScriptBin <cli>`, i.e. it provides
#   `bin/<cli>`. When the real binary for `<cli>` also sits in the same
#   buildEnv (the devenv profile), buildEnv keeps only one `bin/<cli>` and the
#   winner is nondeterministic — the guard might shadow the real, or vice
#   versa, breaking "CI and local resolve the same command paths".
#
#   To make the guard the deterministic owner, pass `realBin` (a derivation or
#   an absolute path). Under passthrough the guard then `exec`s the real binary
#   by its ABSOLUTE store path instead of grepping $PATH. This is load-bearing:
#   once the guard owns `bin/<cli>`, the real is no longer reachable under its
#   own name on $PATH, so the PATH-grep would find nothing and exit 127. The
#   absolute reference also pulls the real into the closure, so the real package
#   can be dropped from (or `lib.lowPrio`'d in) the profile's `packages` list to
#   silence the collision warning while staying reachable.
#
#   When `realBin` is null (e.g. CLIs whose real lives in node_modules/.bin and
#   is not a profile collision), the guard falls back to the PATH-grep lookup.
#
# Usage in task modules:
#
#   let cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
#   in {
#     # `reals` maps cli name -> real derivation/path for guards that own
#     # their command name (collide with a profile-level real).
#     packages = cliGuard.fromTasks { tasks = guardedTasks; reals = { oxlint = oxlintPkg; }; };
#     tasks = cliGuard.stripGuards (guardedTasks // otherTasks);
#   }
#
#   guardedTasks have a `guard = "cli-name"` attribute on entries that
#   should appear in the guard's help message. otherTasks may also call
#   guarded CLIs. stripGuards removes guard attrs and sets DEVENV_TASK_PASSTHROUGH=1
#   on all tasks so they can call guarded CLIs during task execution.
#
# Low-level API (for cases where tasks aren't a plain attrset):
#
#   packages = [
#     (cliGuard.mkCliGuard {
#       cli = "oxlint";
#       realBin = oxlintPkg; # optional; absolute-path exec under passthrough
#       tasks = [
#         { task = "lint:check:oxlint"; description = "Check lint"; }
#       ];
#     })
#   ];
{ pkgs }:
let
  lib = pkgs.lib;

  # Resolve a realBin arg (derivation or absolute path) to an absolute
  # `bin/<cli>` path string, or null when no real was provided.
  resolveRealBin =
    cli: realBin:
    if realBin == null then
      null
    else if lib.isDerivation realBin then
      lib.getExe' realBin cli
    else
      toString realBin;

  # Build a single guard wrapper script for one CLI
  mkCliGuard =
    {
      cli,
      tasks,
      realBin ? null,
    }:
    let
      taskLines = builtins.concatStringsSep "\n" (
        map (
          t:
          let
            desc = if t ? description && t.description != null then "# ${t.description}\\n" else "";
          in
          ''printf "  ${desc}  devenv tasks run ${t.task}\n\n" >&2''
        ) tasks
      );
      realPath = resolveRealBin cli realBin;
      # When the real binary is known, exec it by absolute store path. See the
      # header comment for why PATH-grep cannot work once the guard owns the name.
      passthroughBody =
        if realPath != null then
          ''exec ${lib.escapeShellArg realPath} "$@"''
        else
          ''
            _self="$(cd "''${0%/*}" && pwd -P)"
            _real=""
            IFS=: read -ra _dirs <<< "$PATH"
            for _d in "''${_dirs[@]}"; do
              [ -z "$_d" ] && continue
              _resolved="$(cd "$_d" 2>/dev/null && pwd -P)" || continue
              [ "$_resolved" = "$_self" ] && continue
              if [ -x "$_d/${cli}" ]; then
                if grep -q '^# cli-guard-wrapper:${cli}$' "$_d/${cli}" 2>/dev/null; then
                  continue
                fi
                _real="$_d/${cli}"
                break
              fi
            done
            if [ -z "$_real" ]; then
              echo "cli-guard: '${cli}' not found on PATH (after removing guard)" >&2
              exit 127
            fi
            exec "$_real" "$@"'';
    in
    pkgs.writeShellScriptBin cli ''
      # cli-guard-wrapper:${cli}
      set -euo pipefail

      if [ "''${DEVENV_TASK_PASSTHROUGH:-}" = "1" ]; then
        ${passthroughBody}
      fi

      echo "" >&2
      echo "Instead of running '${cli}' directly, use the devenv task(s):" >&2
      echo "" >&2
      ${taskLines}
      echo "Run 'devenv tasks list' to see all available tasks." >&2
      echo "" >&2
      echo "Bypass (not recommended):" >&2
      echo "  DEVENV_TASK_PASSTHROUGH=1 ${cli} $*" >&2
      echo "" >&2
      exit 1
    '';

  # Extract guard packages from a tasks attrset.
  # Tasks with a `guard = "cli-name"` attribute are grouped by CLI name
  # and a guard wrapper is generated for each group.
  #
  # Accepts either a bare tasks attrset (backward compatible) or
  # `{ tasks, reals }` where `reals` maps a cli name to its real
  # derivation/path. Reals make the guard own `bin/<cli>` deterministically by
  # exec'ing the real via absolute path under passthrough (see header comment).
  fromTasks =
    arg:
    let
      tasks = arg.tasks or arg;
      reals = arg.reals or { };
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
          realBin = reals.${cli} or null;
          tasks = map (e: { inherit (e) task description; }) entries;
        };
    in
    map mkGuardForCli cliNames;

  # Strip the `guard` attribute and set DEVENV_TASK_PASSTHROUGH=1 via per-task env.
  # devenv's module-level `env` attributes are not propagated to task
  # subprocesses, but per-task `env` is. Pass all tasks (guarded + other)
  # so every task can call guarded CLIs during task execution.
  stripGuards = builtins.mapAttrs (
    _: def:
    let
      stripped = builtins.removeAttrs def [ "guard" ];
    in
    stripped
    // {
      env = (stripped.env or { }) // {
        DEVENV_TASK_PASSTHROUGH = "1";
      };
    }
  );

in
{
  inherit mkCliGuard fromTasks stripGuards;
}
