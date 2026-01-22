# Setup task module - runs common setup tasks on shell entry
#
# Wires specified tasks to run as dependencies of devenv:enterShell.
# This uses native devenv task dependency resolution, avoiding the
# double shell entry that occurs when calling `dt` from enterShell.
#
# Usage in devenv.nix:
#   imports = [
#     (taskModules.setup {
#       tasks = [ "pnpm:install" "genie:run" "ts:build" ];
#     })
#   ];
#
# The tasks will run in parallel (respecting their own dependencies)
# as part of the shell entry process.
#
# ## Rebase Guard
#
# During git rebase/cherry-pick, setup tasks are skipped to avoid
# running expensive operations on each commit. The `setup:gate` task
# will intentionally fail during rebase, causing dependent tasks to
# be "skipped due to dependency failure".
#
# This is a tradeoff: the failure message looks alarming but is
# intentional. We chose this approach over alternatives because:
#
# - Option: Add rebase guard to each task module individually
#   Rejected: Duplicates logic across pnpm.nix, genie.nix, ts.nix, etc.
#
# - Option: Use old `dt` approach with enterShell script
#   Rejected: Causes double shell entry (~175s vs ~6s cached)
#
# - Option: Remove rebase guard entirely
#   Rejected: Loses useful automatic skip during rebase
#
# If you need to run setup during rebase, use: `dt setup:run`
{
  tasks ? [ "genie:run" ],
  skipDuringRebase ? true,
}:
{ lib, ... }:
{
  # Gate task that fails during rebase, causing dependent tasks to skip
  # Uses `before` to inject itself as a dependency of each setup task
  tasks."setup:gate" = lib.mkIf skipDuringRebase {
    description = "Check if setup should run (fails during rebase to skip setup)";
    exec = ''
      _git_dir=$(git rev-parse --git-dir 2>/dev/null)
      if [ -d "$_git_dir/rebase-merge" ] || [ -d "$_git_dir/rebase-apply" ]; then
        echo "Skipping setup during git rebase/cherry-pick"
        echo "Run 'dt setup:run' manually if needed"
        exit 1
      fi
    '';
    # This makes setup:gate run BEFORE each of the setup tasks
    # If gate fails, the tasks will be "skipped due to dependency failure"
    before = tasks;
  };

  # Wire setup tasks to run during shell entry via native task dependencies
  tasks."devenv:enterShell".after = tasks;

  # Also provide setup:run for manual invocation (e.g., `dt setup:run`)
  # This does NOT go through the gate, so it works during rebase
  tasks."setup:run" = {
    description = "Run setup tasks (install deps, generate configs, build)";
    after = tasks;
  };
}
