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
#       completionsCliNames = [ "genie" "dotdot" "mr" ];
#     })
#   ];
#
# The tasks will run in parallel (respecting their own dependencies)
# as part of the shell entry process.
#
# Shared caching rules live in ./lib/cache.nix (task-specific details below).
#
# ## Git Hash Caching
#
# By default, setup tasks are skipped if the git HEAD hash hasn't changed
# since the last successful setup. This makes warm shell entry nearly instant.
#
# The hash is stored in .direnv/task-cache/setup-git-hash and updated after successful setup.
#
# Cache inputs:
# - git HEAD (or "no-git" fallback)
#
# Cache file:
# - .direnv/task-cache/setup-git-hash
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
  completionsCliNames ? [],
  skipDuringRebase ? true,
  skipIfGitHashUnchanged ? true,
}:
{ lib, config, ... }:
let
  cache = import ./lib/cache.nix { inherit config; };
  cacheRoot = cache.cacheRoot;
  hashFile = cache.mkCachePath "setup-git-hash";
  userTasks = tasks;
  completionsEnabled = completionsCliNames != [];
  completionsTaskName = "setup:completions";
  completionsCliList = lib.concatStringsSep " " completionsCliNames;
  completionsExec = ''
    shell=""
    if [ -n "''${FISH_VERSION:-}" ]; then
      shell="fish"
    elif [ -n "''${ZSH_VERSION:-}" ]; then
      shell="zsh"
    elif [ -n "''${BASH_VERSION:-}" ]; then
      shell="bash"
    elif [ -n "''${SHELL:-}" ]; then
      case "$SHELL" in
        */fish) shell="fish" ;;
        */zsh) shell="zsh" ;;
        */bash) shell="bash" ;;
      esac
    fi

    if [ -z "$shell" ]; then
      exit 0
    fi

    if [ "$shell" = "fish" ]; then
      completions_dir="''${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions"
      file_prefix=""
      file_suffix=".fish"
    elif [ "$shell" = "zsh" ]; then
      completions_dir="''${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions"
      file_prefix="_"
      file_suffix=""
    else
      completions_dir="''${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions"
      file_prefix=""
      file_suffix=""
    fi

    mkdir -p "$completions_dir"

    for cli in ${completionsCliList}; do
      if ! command -v "$cli" >/dev/null 2>&1; then
        echo "[devenv] Skipping completions for $cli (not on PATH)" >&2
        continue
      fi

      if ! "$cli" --completions "$shell" > "$completions_dir/$file_prefix$cli$file_suffix"; then
        echo "[devenv] Failed to generate completions for $cli" >&2
      fi
    done

    exit 0
  '';
  completionsStatus = ''
    shell=""
    if [ -n "''${FISH_VERSION:-}" ]; then
      shell="fish"
    elif [ -n "''${ZSH_VERSION:-}" ]; then
      shell="zsh"
    elif [ -n "''${BASH_VERSION:-}" ]; then
      shell="bash"
    elif [ -n "''${SHELL:-}" ]; then
      case "$SHELL" in
        */fish) shell="fish" ;;
        */zsh) shell="zsh" ;;
        */bash) shell="bash" ;;
      esac
    fi

    if [ -z "$shell" ]; then
      exit 0
    fi

    if [ "$shell" = "fish" ]; then
      completions_dir="''${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions"
      file_prefix=""
      file_suffix=".fish"
    elif [ "$shell" = "zsh" ]; then
      completions_dir="''${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions"
      file_prefix="_"
      file_suffix=""
    else
      completions_dir="''${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions"
      file_prefix=""
      file_suffix=""
    fi

    for cli in ${completionsCliList}; do
      if ! command -v "$cli" >/dev/null 2>&1; then
        continue
      fi

      if [ ! -f "$completions_dir/$file_prefix$cli$file_suffix" ]; then
        exit 1
      fi
    done

    exit 0
  '';
  setupTasks = userTasks ++ lib.optionals completionsEnabled [ completionsTaskName ];
  
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
  skipSetupIfHashUnchanged = lib.optionalString skipIfGitHashUnchanged ''
    if [ "''${FORCE_SETUP:-}" != "1" ]; then
      current=''${SETUP_GIT_HASH:-$(git rev-parse HEAD 2>/dev/null || echo "no-git")}
      cached=$(cat ${hashFile} 2>/dev/null || echo "")
      if [ "$current" = "$cached" ]; then
        exit 0
      fi
    fi
  '';
  writeHashScript = ''
    new_hash="''${SETUP_GIT_HASH:-$(git rev-parse HEAD 2>/dev/null || echo "no-git")}"
    cache_dir="$(dirname ${hashFile})"
    mkdir -p "$cache_dir"
    cache_value="$new_hash"
    ${cache.writeCacheFile hashFile}
  '';

  # Create status overrides for all setup tasks
  statusOverrides = lib.optionalAttrs skipIfGitHashUnchanged (
    lib.genAttrs userTasks (_: {
      status = lib.mkDefault gitHashStatus;
    })
  );
in
{
  # Merge status overrides with setup-specific tasks
  tasks = statusOverrides // lib.optionalAttrs completionsEnabled {
    "${completionsTaskName}" = {
      description = "Install shell completions for CLI tools";
      exec = completionsExec;
      status = completionsStatus;
    };
  } // {
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
      before = setupTasks;
    };

    # Save git hash after successful setup
    "setup:save-hash" = {
      description = "Save git hash after successful setup";
      exec = ''
        ${writeHashScript}
      '';
      after = setupTasks;
    };

    # Wire setup tasks to run during shell entry via native task dependencies
    # Also save the hash after setup completes
    # NOTE: We use lib.mkForce for exec because devenv 2.0 defines a default exec
    # that we need to override when running in non-strict mode
    "devenv:enterShell" = {
      after = lib.mkIf (builtins.getEnv "DEVENV_STRICT" == "1") (setupTasks ++ [ "setup:save-hash" ]);
      exec = lib.mkIf (builtins.getEnv "DEVENV_STRICT" != "1") (lib.mkForce ''
        ${skipSetupIfHashUnchanged}
        echo "devenv: setup tasks are non-blocking (set DEVENV_STRICT=1 to enforce)"
        for task in ${lib.concatStringsSep " " setupTasks}; do
          if ! devenv tasks run "$task" --mode before; then
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
        FORCE_SETUP=1 devenv tasks run ${lib.concatStringsSep " " setupTasks} --mode before
        ${writeHashScript}
      '';
    };
  };
}
