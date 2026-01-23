# `dt` (devenv tasks) wrapper script and shell completions
# Provides a convenient `dt` command that runs devenv tasks with dependencies.
#
# Usage in devenv.nix:
#   imports = [ inputs.effect-utils.devenvModules.dt ];
#
# Then use: dt check:quick, dt lint:fix, dt test:run, etc.
#
# Fish completions are managed via home-manager (see dotfiles repo).
# Bash/zsh completions are set up automatically via enterShell.
#
# TODO: Remove once devenv supports defaultMode for tasks (https://github.com/cachix/devenv/issues/2417)
{ pkgs, ... }:
{
  # Wrapper that runs tasks with --mode before so dependencies run automatically
  scripts.dt.exec = ''devenv tasks run "$@" --mode before'';

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
