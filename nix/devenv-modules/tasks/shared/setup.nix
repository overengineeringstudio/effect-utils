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
# Required tasks are hard dependencies of devenv:enterShell.
# Optional tasks use the `@completed` suffix so failures don't block shell entry.
#
# ## Rebase Guard
#
# During git rebase/cherry-pick, setup tasks are skipped to avoid
# running expensive operations on each commit. The `setup:gate` task
# will intentionally fail during rebase, causing dependent tasks to
# be "skipped due to dependency failure".
#
# If you need to run setup during rebase, use: `dt setup:run`
{
  requiredTasks ? [ ],
  optionalTasks ? [ ],
  completionsCliNames ? [ ],
  innerCacheDirs ? [ ],
  skipDuringRebase ? true,
}:
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  cache = import ../lib/cache.nix { inherit config; };
  git = "${pkgs.git}/bin/git";
  userRequiredTasks = requiredTasks;
  userOptionalTasks = optionalTasks;
  completionsEnabled = completionsCliNames != [ ];
  completionsTaskName = "setup:completions";
  setupRecordCacheTaskName = "setup:record-cache";
  completionsCliList = lib.concatStringsSep " " completionsCliNames;
  setupFingerprintFile = cache.mkCachePath "setup-fingerprint";
  setupGitHashFile = cache.mkCachePath "setup-git-hash";
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
    if [ "''${DEVENV_SETUP_OUTER_CACHE_HIT:-0}" = "1" ]; then
      exit 0
    fi

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
  allSetupTasks = setupTasks;
  setupInnerCacheDirList = lib.concatMapStringsSep " " lib.escapeShellArg innerCacheDirs;
  setupFingerprintEnv = ''
    compute_setup_fingerprint() {
      # Use git object IDs for tracked inputs and only content-hash dirty files.
      # That keeps the warm-shell fingerprint cheap while still reacting to
      # untracked/generated drift that git object IDs cannot describe.
      _setup_head=$(${git} rev-parse HEAD 2>/dev/null || echo "no-git")
      _setup_generated_from_head=$(
        ${git} grep -l -E '^// Source: .*\.genie\.ts|^# Source: .*\.genie\.ts' HEAD -- . 2>/dev/null || true
      )
      _setup_dirty_files=$(
        {
          ${git} -c core.quotepath=off ls-files \
            --modified \
            --others \
            --exclude-standard \
            --deduplicate \
            -- \
            ':(glob)**/*.genie.ts' \
            ':(glob)**/package.json' 2>/dev/null || true

          for _setup_file in package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc megarepo.kdl megarepo.json megarepo.lock; do
            if [ -f "$_setup_file" ] && ! ${git} ls-files --error-unmatch -- "$_setup_file" >/dev/null 2>&1; then
              printf '%s\n' "$_setup_file"
            elif ! ${git} diff --quiet -- "$_setup_file" 2>/dev/null; then
              printf '%s\n' "$_setup_file"
            fi
          done

          printf '%s\n' "$_setup_generated_from_head" \
            | while IFS= read -r _setup_file; do
                [ -n "$_setup_file" ] || continue
                if [ ! -e "$_setup_file" ] || ! ${git} diff --quiet -- "$_setup_file" 2>/dev/null; then
                  printf '%s\n' "$_setup_file"
                fi
              done
        } | LC_ALL=C sort -u
      )

      {
        printf 'head %s\n' "$_setup_head"

        for _setup_file in package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc megarepo.kdl megarepo.json megarepo.lock; do
          ${git} ls-files -s -- "$_setup_file" 2>/dev/null || true
        done

        ${git} -c core.quotepath=off ls-files -s -- ':(glob)**/*.genie.ts' ':(glob)**/package.json' 2>/dev/null || true

        printf '%s\n' "$_setup_generated_from_head" \
          | while IFS= read -r _setup_file; do
              [ -n "$_setup_file" ] || continue
              ${git} ls-files -s -- "$_setup_file" 2>/dev/null || true
            done

        printf '%s\n' "$_setup_dirty_files" \
          | while IFS= read -r _setup_file; do
              [ -n "$_setup_file" ] || continue
              if [ -f "$_setup_file" ]; then
                printf 'dirty %s\n' "$_setup_file"
                ${pkgs.coreutils}/bin/sha256sum "$_setup_file" | awk '{print $1}'
              else
                printf 'missing %s\n' "$_setup_file"
              fi
            done
      } \
        | LC_ALL=C sort -u \
        | ${pkgs.coreutils}/bin/sha256sum \
        | awk '{print $1}'
    }

    setup_outer_cache_hit() {
      _setup_current_fingerprint="$1"

      if [ "''${FORCE_SETUP:-}" = "1" ]; then
        return 1
      fi

      if [ ! -f ${lib.escapeShellArg setupFingerprintFile} ]; then
        return 1
      fi

      _setup_cached_fingerprint=$(cat ${lib.escapeShellArg setupFingerprintFile} 2>/dev/null || echo "")
      if [ "$_setup_current_fingerprint" != "$_setup_cached_fingerprint" ]; then
        return 1
      fi

      # A matching outer fingerprint is only sufficient once at least one of the
      # task-local caches exists again. This avoids skipping setup after users
      # delete `.direnv/task-cache/*` without changing any tracked inputs.
      if [ -z "${setupInnerCacheDirList}" ]; then
        return 0
      fi

      for _setup_cache_dir_name in ${setupInnerCacheDirList}; do
        _setup_cache_dir=${lib.escapeShellArg cache.cacheRoot}/$_setup_cache_dir_name
        set -- "$_setup_cache_dir"/*.hash
        if [ -f "$1" ]; then
          return 0
        fi
      done

      return 1
    }
  '';
in
{
  tasks = cliGuard.stripGuards (
    lib.optionalAttrs completionsEnabled {
      "${completionsTaskName}" = {
        description = "Install shell completions for CLI tools";
        exec = completionsExec;
        status = completionsStatus;
      };
    }
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
      # The gate exports its computed cache metadata through devenv's native
      # task export channel so every dependent status/exec sees the same
      # `DEVENV_SETUP_*` values without re-running the fingerprint logic.
      "setup:gate" = lib.mkIf skipDuringRebase {
        description = "Check if setup should run (fails during rebase to skip setup)";
        exports = [
          "DEVENV_SETUP_OUTER_CACHE_HIT"
          "DEVENV_SETUP_FINGERPRINT"
          "DEVENV_SETUP_GIT_HASH"
          "TRACEPARENT"
          "OTEL_SHELL_ENTRY_NS"
        ];
        exec = ''
          set -euo pipefail
          ${setupFingerprintEnv}

          _git_dir=$(${git} rev-parse --git-dir 2>/dev/null)
          if [ -d "$_git_dir/rebase-merge" ] || [ -d "$_git_dir/rebase-apply" ]; then
            echo "Skipping setup during git rebase/cherry-pick"
            echo "Run 'dt setup:run' manually if needed"
            exit 1
          fi

          _setup_current_fingerprint="$(compute_setup_fingerprint)"
          _setup_git_hash=$(${git} rev-parse HEAD 2>/dev/null || echo "no-git")
          if setup_outer_cache_hit "$_setup_current_fingerprint"; then
            _setup_outer_cache_hit="1"
          else
            _setup_outer_cache_hit="0"
          fi

          export DEVENV_SETUP_OUTER_CACHE_HIT="$_setup_outer_cache_hit"
          export DEVENV_SETUP_FINGERPRINT="$_setup_current_fingerprint"
          export DEVENV_SETUP_GIT_HASH="$_setup_git_hash"

          if [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
            _root_trace=$(${pkgs.coreutils}/bin/od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
            _root_span=$(${pkgs.coreutils}/bin/od -An -tx1 -N8 /dev/urandom | tr -d ' \n')
            export TRACEPARENT="00-''${_root_trace:0:32}-''${_root_span:0:16}-01"
            export OTEL_SHELL_ENTRY_NS="$(${pkgs.coreutils}/bin/date +%s%N)"
          fi
        '';
        # This makes setup:gate run BEFORE each setup task
        # If gate fails, the tasks will be "skipped due to dependency failure"
        before = allSetupTasks;
      };

      "${setupRecordCacheTaskName}" = lib.mkIf (setupTasks != [ ]) {
        description = "Record the successful setup fingerprint";
        # Persist the outer cache only after the setup tasks finished. Writing it
        # earlier would let later warm shells skip work that never completed.
        after = lib.optionals skipDuringRebase [ "setup:gate" ] ++ setupTasks;
        exec = ''
          set -euo pipefail
          ${setupFingerprintEnv}

          mkdir -p ${lib.escapeShellArg cache.cacheRoot}

          cache_value="''${DEVENV_SETUP_FINGERPRINT:-$(compute_setup_fingerprint)}"
          ${cache.writeCacheFile ''"${setupFingerprintFile}"''}

          cache_value="''${DEVENV_SETUP_GIT_HASH:-$(${git} rev-parse HEAD 2>/dev/null || echo "no-git")}"
          ${cache.writeCacheFile ''"${setupGitHashFile}"''}
        '';
        status = ''
          set -euo pipefail
          if [ "''${FORCE_SETUP:-}" = "1" ]; then
            exit 1
          fi
          if [ "''${DEVENV_SETUP_OUTER_CACHE_HIT:-0}" = "1" ]; then
            exit 0
          fi
          exit 1
        '';
      };

      # Wire setup tasks to run during shell entry.
      # Required tasks are hard dependencies; optional tasks use @completed so
      # failures don't block shell entry.
      "devenv:enterShell" = {
        after = setupRequiredTasks
          ++ (map (t: "${t}@completed") setupOptionalTasks)
          ++ lib.optionals (setupTasks != [ ]) [ "${setupRecordCacheTaskName}@completed" ];
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
    }
  );
}
