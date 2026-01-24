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
# ## Git Hash Caching
#
# By default, setup tasks are skipped if the git HEAD hash hasn't changed
# since the last successful setup. This makes warm shell entry nearly instant.
#
# The hash is stored in .devenv/setup-git-hash and updated after successful setup.
#
# To force tasks to run despite unchanged hash:
#   FORCE_SETUP=1 dt genie:run
#   dt setup:run  # Always forces all setup tasks
#
# For testing, you can override the git hash:
#   SETUP_GIT_HASH=test-hash-123 devenv shell
#
# ## Rebase Guard
#
# During git rebase/cherry-pick, setup tasks are skipped to avoid
# running expensive operations on each commit. The `setup:gate` task
# will intentionally fail during rebase, causing dependent tasks to
# be "skipped due to dependency failure".
#
# If you need to run setup during rebase, use: `FORCE_SETUP=1 dt setup:run`
#
# ## Strict Mode
#
# By default, setup tasks run in a non-blocking mode on shell entry; failures
# emit warnings but do not prevent the shell from loading.
#
# Set `DEVENV_STRICT=1` to enforce setup tasks and fail fast on errors.
{
  tasks ? [ "genie:run" ],
  skipDuringRebase ? true,
  skipIfGitHashUnchanged ? true,
}:
{ lib, config, ... }:
let
  hashFile = "${config.devenv.root}/.devenv/setup-git-hash";
  
  # Status check that skips task if git hash unchanged
  # Returns 0 (skip) if hash matches, non-zero (run) if different
  gitHashStatus = ''
    # Allow bypass via FORCE_SETUP=1
    [ "$FORCE_SETUP" = "1" ] && exit 1
    
    # Allow override via SETUP_GIT_HASH for testing
    current=''${SETUP_GIT_HASH:-$(git rev-parse HEAD 2>/dev/null || echo "no-git")}
    cached=$(cat ${hashFile} 2>/dev/null || echo "")
    [ "$current" = "$cached" ]
  '';

  # Create status overrides for all setup tasks
  statusOverrides = lib.optionalAttrs skipIfGitHashUnchanged (
    lib.genAttrs tasks (_: {
      status = lib.mkDefault gitHashStatus;
    })
  );
in
{
  # Merge status overrides with setup-specific tasks
  tasks = statusOverrides // {
    # Gate task that fails during rebase, causing dependent tasks to skip
    # Uses `before` to inject itself as a dependency of each setup task
    "setup:gate" = lib.mkIf skipDuringRebase {
      description = "Check if setup should run (fails during rebase to skip setup)";
      exec = ''
        _git_dir=$(git rev-parse --git-dir 2>/dev/null)
        if [ -d "$_git_dir/rebase-merge" ] || [ -d "$_git_dir/rebase-apply" ]; then
          echo "Skipping setup during git rebase/cherry-pick"
          echo "Run 'FORCE_SETUP=1 dt setup:run' manually if needed"
          exit 1
        fi
      '';
      # This makes setup:gate run BEFORE each of the setup tasks
      # If gate fails, the tasks will be "skipped due to dependency failure"
      before = tasks;
    };

    # Save git hash after successful setup
    "setup:save-hash" = {
      description = "Save git hash after successful setup";
      exec = ''
        mkdir -p "$(dirname ${hashFile})"
        # Allow override via SETUP_GIT_HASH for testing
        echo "''${SETUP_GIT_HASH:-$(git rev-parse HEAD 2>/dev/null || echo "no-git")}" > ${hashFile}
      '';
      after = tasks;
    };

    # Wire setup tasks to run during shell entry via native task dependencies
    # Also save the hash after setup completes
    # NOTE: We use lib.mkForce for exec because devenv 2.0 defines a default exec
    # that we need to override when running in non-strict mode
    "devenv:enterShell" = {
      after = lib.mkIf (builtins.getEnv "DEVENV_STRICT" == "1") (tasks ++ [ "setup:save-hash" ]);
      exec = lib.mkIf (builtins.getEnv "DEVENV_STRICT" != "1") (lib.mkForce ''
        echo "devenv: setup tasks are non-blocking (set DEVENV_STRICT=1 to enforce)"
        for task in ${lib.concatStringsSep " " tasks}; do
          if ! devenv tasks run "$task"; then
            echo "Warning: setup task '$task' failed. Run 'dt $task' for details." >&2
          fi
        done
        devenv tasks run setup:save-hash >/dev/null 2>&1 || true
      '');
    };

    # Force-run setup tasks (bypasses git hash check)
    # Useful during rebase or when you want to force a rebuild
    "setup:run" = {
      description = "Force run setup tasks (ignores git hash cache)";
      exec = ''
        FORCE_SETUP=1 devenv tasks run ${lib.concatStringsSep " " tasks}
        mkdir -p "$(dirname ${hashFile})"
        # Allow override via SETUP_GIT_HASH for testing
        echo "''${SETUP_GIT_HASH:-$(git rev-parse HEAD 2>/dev/null || echo "no-git")}" > ${hashFile}
      '';
    };
  };
}
