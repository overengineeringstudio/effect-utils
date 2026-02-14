# `dt` (devenv tasks) wrapper script and shell completions
# Provides a convenient `dt` command that runs devenv tasks with dependencies.
#
# Usage in devenv.nix:
#   imports = [ inputs.effect-utils.devenvModules.dt ];
#
# Then use: dt check:quick, dt lint:fix, dt test:run, etc.
#
# Flags:
#   -f / --fresh   Bypass task caches (passes --refresh-task-cache to devenv).
#                  Requires devenv >= ef99a1f (2026-02-12).
#
# Fish completions are managed via home-manager (see dotfiles repo).
# Bash/zsh completions are set up automatically via enterShell.
#
# TODO: Remove once devenv supports defaultMode for tasks (https://github.com/cachix/devenv/issues/2417)
{ pkgs, ... }:
{
  # Wrapper that runs tasks with --mode before so dependencies run automatically.
  # When OTEL is configured (otel-span on PATH + OTEL_EXPORTER_OTLP_ENDPOINT set),
  # wraps execution in an OTLP trace span for observability.
  scripts.dt.exec = ''
    # Parse dt-specific flags before forwarding to devenv
    _dt_extra_args=""
    _dt_args=()
    for arg in "$@"; do
      case "$arg" in
        -f|--fresh)
          _dt_extra_args="$_dt_extra_args --refresh-task-cache"
          ;;
        *)
          _dt_args+=("$arg")
          ;;
      esac
    done
    set -- "''${_dt_args[@]}"

    # Auto-detect non-interactive environments (CI, piped output, git hooks)
    _dt_tui_flag=""
    if [ -n "''${CI:-}" ] || ! [ -t 1 ]; then
      _dt_tui_flag="--no-tui"
    fi

    task_name="''${1:-unknown}"

    if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
      # Calculate time since shell entry (approximates Nix eval + setup time)
      _eval_attr=""
      if [ -n "''${SHELL_ENTRY_TIME_NS:-}" ]; then
        _now_ns=$(date +%s%N)
        _elapsed_ms=$(( (_now_ns - SHELL_ENTRY_TIME_NS) / 1000000 ))
        _eval_attr="--attr shell.ready_ms=$_elapsed_ms"
      fi

      # Preserve current task trace context explicitly for task subprocesses.
      # Prefer OTEL_TASK_TRACEPARENT when called from a nested dt/task wrapper.
      # Never inherit ambient TRACEPARENT; always start from a clean trace unless
      # the parent context is explicitly passed in.
      _trace_id=""
      _parent_span_id=""
      if [ -n "''${OTEL_TASK_TRACEPARENT:-}" ]; then
        IFS='-' read -r _ _trace_id _parent_span_id _ <<< "''${OTEL_TASK_TRACEPARENT}"
      fi

      if [ -z "$_trace_id" ]; then
        _trace_id=$(${pkgs.coreutils}/bin/od -An -tx1 -N16 /dev/urandom | ${pkgs.coreutils}/bin/tr -d ' \n')
      fi

      _span_id=$(${pkgs.coreutils}/bin/od -An -tx1 -N8 /dev/urandom | ${pkgs.coreutils}/bin/tr -d ' \n')
      _task_traceparent="00-''${_trace_id}-''${_span_id}-01"

      _dt_span_opts=""
      if [ -n "''${_parent_span_id}" ]; then
        _dt_span_opts="--trace-id ''${_trace_id} --parent-span-id ''${_parent_span_id} --span-id ''${_span_id}"
      else
        _dt_span_opts="--trace-id ''${_trace_id} --span-id ''${_span_id}"
      fi

      # OTEL available: wrap task in a trace span
      if ! TRACEPARENT="" OTEL_TASK_TRACEPARENT="$_task_traceparent" otel-span run "dt" "$task_name" $_dt_span_opts --log-url $_eval_attr --attr "dt.args=$*" \
        -- devenv tasks run "$@" --mode before $_dt_extra_args $_dt_tui_flag; then
        echo "dt: task failed. Re-run with: devenv tasks run $* --mode before --no-tui" >&2
        exit 1
      fi
    else
      # No OTEL: run directly
      if ! devenv tasks run "$@" --mode before $_dt_extra_args $_dt_tui_flag; then
        echo "dt: task failed. Re-run with: devenv tasks run $* --mode before --no-tui" >&2
        exit 1
      fi
    fi
  '';

  packages = [ pkgs.jq ];

  # Shell completions for bash/zsh with descriptions
  enterShell = ''
    : "''${ZSH_VERSION:=}"
    # Shell completions for `dt` command (cached for performance)
    # Uses task config JSON for names and descriptions
    _dt_get_tasks_with_desc() {
      local cache="$DEVENV_DOTFILE/.tasks-cache-desc"
      local config="$DEVENV_DOTFILE/gc/task-config"
      # Refresh cache if config is newer or cache doesn't exist
      if [[ ! -f "$cache" ]] || [[ "$config" -nt "$cache" ]]; then
        if [[ -f "$config" ]]; then
          # Extract name and description from JSON, format as "name:description"
          jq -r '.[] | "\(.name):\(.description // "")"' "$config" 2>/dev/null | sort > "$cache" || true
        else
          # Fallback: just get names from devenv tasks list
          devenv tasks list 2>/dev/null | grep -oE '[a-z]+:[a-z0-9:-]+' | sort -u | sed 's/$/:/' > "$cache" || true
        fi
      fi
      cat "$cache" 2>/dev/null
    }

    _dt_get_tasks() {
      _dt_get_tasks_with_desc | cut -d: -f1-2
    }

    if [[ -n "$ZSH_VERSION" ]]; then
      _dt_completions() {
        local -a tasks
        local line
        while IFS= read -r line; do
          local name="''${line%%:*}"
          local rest="''${line#*:}"
          local desc="''${rest#*:}"
          if [[ -n "$desc" ]]; then
            tasks+=("$name:$desc")
          else
            tasks+=("$name")
          fi
        done < <(_dt_get_tasks_with_desc)
        _describe 'task' tasks
      }
      compdef _dt_completions dt
    elif [[ -n "$BASH_VERSION" ]]; then
      _dt_completions() {
        local cur tasks
        cur="''${COMP_WORDS[COMP_CWORD]}"
        # Bash doesn't support descriptions well, just use names
        tasks=$(_dt_get_tasks)
        COMPREPLY=($(compgen -W "$tasks" -- "$cur"))
      }
      complete -F _dt_completions dt
    fi
  '';
}
