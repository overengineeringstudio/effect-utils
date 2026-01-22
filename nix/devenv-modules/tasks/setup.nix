# Setup task module - runs common setup tasks on shell entry
#
# Usage in devenv.nix:
#   imports = [
#     (taskModules.setup {
#       tasks = [ "bun:install" "genie:run" "ts:build" ];
#     })
#   ];
#
# Provides: setup:run (auto-wired to enterShell by default)
{
  tasks ? [ "genie:run" ],
  skipDuringRebase ? true,
  autoRun ? true,
  envVar ? "DEVENV_SKIP_SETUP",
}:
{ lib, ... }:
{
  tasks."setup:run" = {
    description = "Run setup tasks (install deps, generate configs, build)";
    exec = ''
      ${lib.optionalString skipDuringRebase ''
        _git_dir=$(git rev-parse --git-dir 2>/dev/null)
        if [ -d "$_git_dir/rebase-merge" ] || [ -d "$_git_dir/rebase-apply" ]; then
          echo "[setup] Skipping during git rebase"
          exit 0
        fi
      ''}
      # Prevent recursion when dt spawns new shells for task execution
      export ${envVar}=1
      dt ${lib.concatStringsSep " " tasks} || true
    '';
  };

  enterShell = lib.mkIf autoRun (lib.mkAfter ''
    if [ -z "''${${envVar}:-}" ]; then
      # Set DEVENV_SKIP_SETUP to prevent infinite recursion when dt spawns a new shell
      ${envVar}=1 dt setup:run
    fi
  '');
}
