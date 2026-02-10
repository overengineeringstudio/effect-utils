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
#     })
#   ];
#
# The tasks will run as part of shell entry.
#
# Optional task failures:
#
# Upstream devenv regression: optional task failures can cause `devenv shell` / direnv
# activation to exit non-zero again (R15). We work around this by introducing wrapper
# tasks for shell entry optional work.
#
# Upstream issue:
# - https://github.com/cachix/devenv/issues/2480
#
# Cleanup checklist once upstream is fixed:
# - Remove wrapper tasks (setup:opt:*) and switch back to native `@complete` deps.
# - Remove nested `devenv tasks run` calls from wrappers.
# - Consider reintroducing a single optional gate task without wrappers.
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
# Optional tasks are wired through a gate task (`setup:optional`) which depends on
# wrapper tasks (`setup:opt:*`). Wrappers always exit 0 so shell entry remains resilient
# even if upstream failure handling regresses.
{
  requiredTasks ? [ ],
  optionalTasks ? [ ],
  completionsCliNames ? [ ],
  skipDuringRebase ? true,
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

  # Shell entry optional tasks run via wrapper tasks that never fail.
  # This keeps direnv activation resilient even when upstream dependency failure
  # handling regresses.
  mkOptionalWrapperTaskName = t: "setup:opt:${lib.replaceStrings [ ":" ] [ "-" ] t}";
  optionalWrapperTasks = map mkOptionalWrapperTaskName setupOptionalTasks;

  optionalGateTaskName = "setup:optional";
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
      # - Runs wrapper tasks as dependencies; wrappers swallow failures so shell entry
      #   stays resilient.
      "${optionalGateTaskName}" = lib.mkIf (setupOptionalTasks != [ ]) ({
        description = "Shell entry optional tasks (best effort)";
        exec = "exit 0";
        after = optionalWrapperTasks;
      });

      # Wrapper tasks for shell entry optional work.
      #
      # Why wrappers?
      # - We cannot depend directly on optional tasks (or use @complete) without risking
      #   `devenv shell` returning non-zero on failures in some upstream versions.
      # - Wrappers run the real task via a nested `devenv tasks run ...` and always exit 0.
      #
      # Strict mode (`setup:strict` / DEVENV_STRICT=1) still depends on the real tasks
      # so failures are enforced when explicitly requested.
    }
    // (lib.listToAttrs (
      map (
        t:
        let
          wrapper = mkOptionalWrapperTaskName t;
        in
        {
          name = wrapper;
          value = {
            description = "Optional setup wrapper (best effort): ${t}";
            exec = ''
              set -u
              set -o pipefail

              echo "[devenv] optional setup: ${t}" >&2

              if devenv tasks run "${t}" --mode before --no-tui --show-output; then
                exit 0
              fi

              code=$?
              echo "[devenv] WARN: optional setup task failed: ${t} (exit $code)" >&2
              echo "[devenv] WARN: shell continues; re-run with: dt ${t}" >&2
              exit 0
            '';
          };
        }
      ) setupOptionalTasks
    ))
    // {

      # Strict variant of setup tasks.
      #
      # Use for CI or explicit runs (R16): failures should be enforced.
      "setup:strict" = lib.mkIf (setupTasks != [ ]) {
        description = "Setup tasks (strict)";
        exec = "exit 0";
        after = setupTasks;
      };

      # Gate task that fails during rebase, causing dependent tasks to skip.
      # Uses `before` to inject itself as a dependency of each setup task.
      #
      # OTEL trace propagation:
      # Generates a W3C TRACEPARENT and propagates it to dependent tasks via
      # devenv's native task output → env mechanism (devenv.env convention).
      # When a task writes {"devenv":{"env":{"KEY":"VAL"}}} to $DEVENV_TASK_OUTPUT_FILE,
      # devenv injects those as env vars into all subsequent task subprocesses.
      # Ref: https://github.com/cachix/devenv/blob/main/devenv-tasks/src/task_state.rs#L134-L154
      # Ref: https://devenv.sh/tasks/ (Task Inputs and Outputs)
      "setup:gate" = lib.mkIf skipDuringRebase {
        description = "Check if setup should run (fails during rebase to skip setup)";
        exec = ''
          _git_dir=$(${git} rev-parse --git-dir 2>/dev/null)
          if [ -d "$_git_dir/rebase-merge" ] || [ -d "$_git_dir/rebase-apply" ]; then
            echo "Skipping setup during git rebase/cherry-pick"
            echo "Run 'dt setup:run' manually if needed"
            exit 1
          fi

          # Generate root trace context and propagate via devenv task output.
          # Dependent tasks automatically receive TRACEPARENT + OTEL_SHELL_ENTRY_NS
          # as env vars, linking all shell entry spans into a single trace.
          if [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] && [ -n "''${DEVENV_TASK_OUTPUT_FILE:-}" ]; then
            _root_trace=$(${pkgs.coreutils}/bin/od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
            _root_span=$(${pkgs.coreutils}/bin/od -An -tx1 -N8 /dev/urandom | tr -d ' \n')
            _tp="00-''${_root_trace:0:32}-''${_root_span:0:16}-01"
            _now_ns=$(${pkgs.coreutils}/bin/date +%s%N)
            printf '{"devenv":{"env":{"TRACEPARENT":"%s","OTEL_SHELL_ENTRY_NS":"%s"}}}' \
              "$_tp" "$_now_ns" > "$DEVENV_TASK_OUTPUT_FILE"
          fi
        '';
        # This makes setup:gate run BEFORE each setup task
        # If gate fails, the tasks will be "skipped due to dependency failure"
        before = allSetupTasks;
      };

      # Wire setup tasks to run during shell entry.
      # Required tasks are hard dependencies; optional tasks are best-effort via wrappers.
      # The root OTEL span is emitted in enterShell (devenv.nix) where SHELL_ENTRY_TIME_NS
      # is available, using TRACEPARENT propagated from setup:gate via devenv.env.
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
