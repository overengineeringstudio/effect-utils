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
#       completionsCliNames = [ "genie" "mr" ];
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
# ## Soft Dependencies
#
# Setup tasks use the `@complete` suffix for non-blocking dependencies.
# Tasks run on shell entry but failures don't prevent shell loading.
# See: https://github.com/cachix/devenv/issues/2435
{
  tasks ? null,
  requiredTasks ? [ ],
  optionalTasks ? [ ],
  completionsCliNames ? [],
  skipDuringRebase ? true,
  skipIfGitHashUnchanged ? true,
}:
{ lib, config, ... }:
let
  cache = import ../lib/cache.nix { inherit config; };
  cacheRoot = cache.cacheRoot;
  hashFile = cache.mkCachePath "setup-git-hash";
  userRequiredTasks = if tasks == null then requiredTasks else tasks;
  userOptionalTasks = if tasks == null then optionalTasks else [ ];
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
  setupRequiredTasks = userRequiredTasks;
  setupOptionalTasks = userOptionalTasks ++ lib.optionals completionsEnabled [ completionsTaskName ];
  setupTasks = setupRequiredTasks ++ setupOptionalTasks;
  
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
  writeHashScript = ''
    new_hash="''${SETUP_GIT_HASH:-$(git rev-parse HEAD 2>/dev/null || echo "no-git")}"
    cache_dir="$(dirname ${hashFile})"
    mkdir -p "$cache_dir"
    cache_value="$new_hash"
    ${cache.writeCacheFile hashFile}
  '';

  # Create status overrides for all setup tasks
  statusOverrides = lib.optionalAttrs skipIfGitHashUnchanged (
    lib.genAttrs setupTasks (_: {
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
      after = setupRequiredTasks;
    };

    # Wire setup tasks to run during shell entry via native soft dependencies.
    # The @complete suffix means: wait for task to finish, but don't fail if it fails.
    "devenv:enterShell" = {
      after = setupRequiredTasks ++
        (map (t: "${t}@complete") setupOptionalTasks) ++
        [ "setup:save-hash@complete" ];
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
