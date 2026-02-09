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
#       optionalTasks = [ "pnpm:install" "genie:run" "ts:emit" ];
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
# ## Rebase Guard
#
# During git rebase/cherry-pick, setup tasks are skipped to avoid
# running expensive operations on each commit. The `setup:gate` task
# will intentionally fail during rebase, causing dependent tasks to
# be "skipped due to dependency failure".
#
# If you need to run setup during rebase, use: `dt setup:run`
#
# ## Optional Tasks
#
# Optional tasks are wired through a single gate task (`setup:optional`) which:
#
# - depends on optional tasks using the `@complete` suffix so failures don't block
#   shell entry (direnv expects `devenv shell` to exit 0 on success)
#
# This module intentionally does not try to "skip" work via an outer caching layer.
# Individual tasks should implement correct `status` checks.
{
  requiredTasks ? [ ],
  optionalTasks ? [ ],
  completionsCliNames ? [ ],
  skipDuringRebase ? true,
  # Deprecated: setup-level skipping is intentionally not implemented.
  # Keep these args for backwards compatibility with repos importing this module.
  skipIfGitHashUnchanged ? true,
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
in
{
  tasks =
    lib.optionalAttrs completionsEnabled {
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
      "${optionalGateTaskName}" = lib.mkIf (setupOptionalTasks != [ ]) ({
        description = "Shell entry optional tasks (best effort)";
        exec = "exit 0";
        after = optionalGateDeps;
      });

      # Strict variant of shell-entry optional tasks.
      #
      # Use for CI or explicit runs (R16): failures should be enforced.
      "setup:strict" = lib.mkIf (setupOptionalTasks != [ ]) {
        description = "Shell entry optional tasks (strict)";
        exec = "exit 0";
        after = setupOptionalTasks;
      };

      # Gate task that fails during rebase, causing dependent tasks to skip
      # Uses `before` to inject itself as a dependency of each setup task
      "setup:gate" = lib.mkIf skipDuringRebase {
        description = "Check if setup should run (fails during rebase to skip setup)";
        exec = ''
          _git_dir=$(${git} rev-parse --git-dir 2>/dev/null)
          if [ -d "$_git_dir/rebase-merge" ] || [ -d "$_git_dir/rebase-apply" ]; then
            echo "Skipping setup during git rebase/cherry-pick"
            echo "Run 'dt setup:run' manually if needed"
            exit 1
          fi

          # Generate root trace context for shell entry if OTEL is available
          if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
            if [ -z "''${TRACEPARENT:-}" ]; then
              _root_trace=$(${pkgs.coreutils}/bin/od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
              _root_span=$(${pkgs.coreutils}/bin/od -An -tx1 -N8 /dev/urandom | tr -d ' \n')
              export TRACEPARENT="00-''${_root_trace:0:32}-''${_root_span:0:16}-01"
            fi
          fi
        '';
        # This makes setup:gate run BEFORE each setup task
        # If gate fails, the tasks will be "skipped due to dependency failure"
        before = allSetupTasks;
      };

      # Wire setup tasks to run during shell entry.
      # Required tasks are hard dependencies; optional tasks are best-effort via @complete.
      "devenv:enterShell" = {
        after = allSetupTasks;
      };

      # Run setup tasks explicitly.
      #
      # - Default: best-effort (mirrors shell entry, doesn't fail the command)
      # - DEVENV_STRICT=1: strict mode (fails on task errors)
      "setup:run" = {
        description = "Run setup tasks (DEVENV_STRICT=1 to fail on errors)";
        exec = ''
          set -euo pipefail

          if [ "''${DEVENV_STRICT:-}" = "1" ]; then
            devenv tasks run setup:strict --mode before
            exit 0
          fi

          # Best effort: run each task but swallow failures (devenv tasks run
          # can still exit non-zero if any task in the graph failed).
          for t in ${lib.concatStringsSep " " setupTasks}; do
            devenv tasks run "$t" --mode before || true
          done
        '';
      };
    };
}
