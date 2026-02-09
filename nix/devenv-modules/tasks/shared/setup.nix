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
#       # innerCacheDirs = [ "pnpm-install" ];  # default; set to [] for non-pnpm setups
#     })
#   ];
#
# The tasks will run as part of shell entry.
#
# Optional task failures:
# We model optional shell-entry work via `@complete` dependencies so failures don't block
# entering the shell (direnv expects `devenv shell` to exit 0 on success).
#
# See: https://github.com/cachix/devenv/issues/2454
#
# Shared caching rules live in ./lib/cache.nix (task-specific details below).
#
# ## Git Hash Caching (Two-Tier Design)
#
# Setup tasks use a two-tier caching strategy for R5/R11 compliance:
#
# Outer tier: Git hash (fast check)
# - Stored in .direnv/task-cache/setup-git-hash
# - Updated after successful setup
#
# Inner tier: Per-task content caches (e.g., pnpm-install/*.hash)
# - Created by individual tasks (pnpm:install writes per-package hashes)
# - Content-addressed for correctness
# - Configurable via `innerCacheDirs` parameter
#
# Tasks are skipped only when BOTH tiers are valid:
# - Git hash matches cached value
# - Inner cache directories contain *.hash files (or innerCacheDirs is empty)
#
# This ensures fresh clones/cache-clears populate inner caches correctly.
# For non-pnpm setups, set `innerCacheDirs = []` to use git-hash-only caching.
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
# Optional tasks are wired through a single gate task (`setup:optional`) which:
#
# - depends on optional tasks using the `@complete` suffix so failures don't block
#   shell entry (direnv expects `devenv shell` to exit 0 on success)
# - carries the git-hash/inner-cache skip logic so optional tasks aren't skipped
#   when run directly via `dt <task>`
#
# Related: https://github.com/cachix/devenv/issues/2454
{
  requiredTasks ? [ ],
  optionalTasks ? [ ],
  completionsCliNames ? [ ],
  skipDuringRebase ? true,
  skipIfGitHashUnchanged ? true,
  # Inner cache directories to check for *.hash files (two-tier caching).
  # Set to [] for non-pnpm setups to use git-hash-only caching.
  innerCacheDirs ? [ "pnpm-install" ],
}:
{
  lib,
  config,
  pkgs,
  ...
}:
let
  git = "${pkgs.git}/bin/git";
  cache = import ../lib/cache.nix { inherit config; };
  cacheRoot = cache.cacheRoot;
  hashFile = cache.mkCachePath "setup-git-hash";
  userRequiredTasks = requiredTasks;
  userOptionalTasks = optionalTasks;
  completionsEnabled = completionsCliNames != [ ];
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

  optionalGateTaskName = "setup:optional";
  optionalGateDeps = map (t: "${t}@complete") setupOptionalTasks;
  allSetupTasks =
    setupRequiredTasks ++ lib.optionals (setupOptionalTasks != [ ]) [ optionalGateTaskName ];

  # Status check that skips task if git hash unchanged AND inner caches exist
  # Returns 0 (skip) if conditions met, non-zero (run) otherwise
  #
  # Two-tier cache design (R5, R11 compliance):
  # - Outer tier: git hash (fast check, updated after setup completes)
  # - Inner tier: per-task content hashes (e.g., pnpm-install/*.hash)
  #
  # We only skip when BOTH tiers are valid. This ensures:
  # - Fresh clones populate inner caches even if git hash matches
  # - Cache clearing doesn't leave tasks in broken state
  #
  # If innerCacheDirs is empty, we skip the inner cache check (git-hash-only mode).
  # This is useful for non-pnpm setups that don't have inner caches.
  innerCacheDirsShell = lib.concatStringsSep " " innerCacheDirs;
  gitHashStatus = ''
    # Allow bypass via FORCE_SETUP=1
    [ "$FORCE_SETUP" = "1" ] && exit 1

    # Allow override via SETUP_GIT_HASH for testing
    current=''${SETUP_GIT_HASH:-$(${git} rev-parse HEAD 2>/dev/null || echo "no-git")}
    cached=$(cat ${hashFile} 2>/dev/null || echo "")

    # If git hash differs, always run
    if [ "$current" != "$cached" ]; then
      exit 1
    fi

    # Git hash matches - check if inner caches are populated
    inner_cache_dirs="${innerCacheDirsShell}"

    # If no inner cache dirs configured, use git-hash-only mode (skip inner check)
    if [ -z "$inner_cache_dirs" ]; then
      exit 0
    fi

    # Check each configured inner cache dir for *.hash files
    for dir_name in $inner_cache_dirs; do
      cache_dir="${cacheRoot}/$dir_name"
      # Directory must exist and contain at least one .hash file
      if [ -d "$cache_dir" ]; then
        # Simple and reliable: iterate over files and check suffix
        for f in "$cache_dir"/*; do
          case "$f" in
            *.hash)
              [ -f "$f" ] && exit 0
              ;;
          esac
        done
      fi
    done

    # No valid inner caches found - run to populate them
    exit 1
  '';
  writeHashScript = ''
    new_hash="''${SETUP_GIT_HASH:-$(${git} rev-parse HEAD 2>/dev/null || echo "no-git")}"
    cache_dir="$(dirname ${hashFile})"
    mkdir -p "$cache_dir"
    cache_value="$new_hash"
    ${cache.writeCacheFile hashFile}
  '';

  # Create status overrides for required tasks only
  # Optional tasks are gated by setup:optional (below) so they aren't affected.
  statusOverrides = lib.optionalAttrs skipIfGitHashUnchanged (
    lib.genAttrs setupRequiredTasks (_: {
      status = lib.mkDefault gitHashStatus;
    })
  );
in
{
  # Merge status overrides and setup-specific tasks
  tasks =
    statusOverrides
    // lib.optionalAttrs completionsEnabled {
      "${completionsTaskName}" = {
        description = "Install shell completions for CLI tools";
        exec = completionsExec;
        status = completionsStatus;
      };
    }
    // {
      # Gate for shell-entry optional tasks.
      #
      # - Runs optional tasks as upstream dependencies, marked with @complete so failures
      #   don't block the shell.
      # - Applies the git-hash/inner-cache skip logic without mutating the optional tasks
      #   themselves (so `dt ts:build` etc still behave normally).
      "${optionalGateTaskName}" = lib.mkIf (setupOptionalTasks != [ ]) (
        {
          description = "Shell entry optional tasks (best effort)";
          exec = "exit 0";
          after = optionalGateDeps;
        }
        // lib.optionalAttrs skipIfGitHashUnchanged {
          status = gitHashStatus;
        }
      );

      # Gate task that fails during rebase, causing dependent tasks to skip
      # Uses `before` to inject itself as a dependency of each setup task
      "setup:gate" = lib.mkIf skipDuringRebase {
        description = "Check if setup should run (fails during rebase to skip setup)";
        exec = ''
          _git_dir=$(${git} rev-parse --git-dir 2>/dev/null)
          if [ -d "$_git_dir/rebase-merge" ] || [ -d "$_git_dir/rebase-apply" ]; then
            echo "Skipping setup during git rebase/cherry-pick"
            echo "Run 'FORCE_SETUP=1 dt setup:run' manually if needed"
            exit 1
          fi
        '';
        # This makes setup:gate run BEFORE each setup task
        # If gate fails, the tasks will be "skipped due to dependency failure"
        before = allSetupTasks;
      };

      # Save git hash after successful setup
      "setup:save-hash" = {
        description = "Save git hash after successful setup";
        exec = ''
          ${writeHashScript}
        '';
        after = allSetupTasks;
      };

      # Wire setup tasks to run during shell entry.
      # Required tasks are hard dependencies; optional tasks are best-effort via @complete.
      "devenv:enterShell" = {
        after = [ "setup:save-hash" ];
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
