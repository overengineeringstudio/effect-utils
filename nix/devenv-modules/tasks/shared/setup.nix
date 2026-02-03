# Setup task module - runs common setup tasks on shell entry
#
# Wires specified tasks to run as dependencies of devenv:enterShell.
# This uses native devenv task dependency resolution, avoiding the
# double shell entry that occurs when calling `dt` from enterShell.
#
# Usage in devenv.nix:
#   imports = [
#     (taskModules.setup {
#       requiredTasks = [ ];
#       optionalTasks = [ "pnpm:install" "genie:run" "ts:build" ];
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
# ## Optional Tasks
#
# Optional tasks are wrapped so failures don't cause devenv to exit non-zero
# (which would break direnv). Each optional task gets a `setup:opt:<name>`
# wrapper that runs `devenv tasks run <name> || true`.
# TODO: Remove wrapper workaround once https://github.com/cachix/devenv/issues/2454 is fixed
# and use @complete suffix directly instead.
{
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
  userRequiredTasks = requiredTasks;
  userOptionalTasks = optionalTasks;
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

  # TODO: Remove wrappers once https://github.com/cachix/devenv/issues/2454 is fixed
  # Workaround: devenv exits non-zero if any task in the graph fails, even when
  # the root task succeeds via @complete. We create wrapper tasks that call
  # `devenv tasks run <task> || true` so they always succeed.
  #
  # IMPORTANT: The recursion guard (_DEVENV_SETUP_RUNNING) prevents runaway process
  # spawning. Without it, nested devenv evaluations can cause hundreds of parallel
  # `devenv print-dev-env` processes, overwhelming the system.
  mkWrapperName = t: "setup:opt:${t}";
  wrappedOptionalTasks = map mkWrapperName setupOptionalTasks;
  wrapperTasks = lib.listToAttrs (map (t: {
    name = mkWrapperName t;
    value = {
      description = "Optional setup: ${t}";
      exec = ''
        # Recursion guard: prevent nested devenv from spawning more wrappers
        if [ -n "''${_DEVENV_SETUP_RUNNING:-}" ]; then
          exit 0
        fi
        export _DEVENV_SETUP_RUNNING=1
        devenv tasks run ${t} || true
      '';
    };
  }) setupOptionalTasks);
  allSetupTasks = setupRequiredTasks ++ wrappedOptionalTasks;

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

  # Create status overrides for required tasks and wrappers
  statusOverrides = lib.optionalAttrs skipIfGitHashUnchanged (
    lib.genAttrs allSetupTasks (_: {
      status = lib.mkDefault gitHashStatus;
    })
  );
in
{
  # Merge status overrides, wrappers, and setup-specific tasks
  tasks = statusOverrides // wrapperTasks // lib.optionalAttrs completionsEnabled {
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
      # This makes setup:gate run BEFORE each setup task (and wrappers)
      # If gate fails, the tasks will be "skipped due to dependency failure"
      before = allSetupTasks;
    };

    # Save git hash after successful setup
    "setup:save-hash" = {
      description = "Save git hash after successful setup";
      exec = ''
        ${writeHashScript}
      '';
      after = setupRequiredTasks;
    };

    # Wire setup tasks to run during shell entry.
    # Required tasks are hard dependencies; wrappers are also hard deps
    # but they internally swallow failures via `|| true`.
    "devenv:enterShell" = {
      after = allSetupTasks ++
        [ "setup:save-hash" ];
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
