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
{ ... }:
{
  # Wrapper that runs tasks with --mode before so dependencies run automatically
  scripts.dt.exec = ''devenv tasks run "$@" --mode before'';

  # Shell completions for bash/zsh
  enterShell = ''
    # Shell completions for `dt` command (cached for performance)
    _dt_get_tasks() {
      local cache="$DEVENV_DOTFILE/.tasks-cache"
      # Refresh cache if older than 5 minutes or doesn't exist
      if [[ ! -f "$cache" ]] || [[ $(find "$cache" -mmin +5 2>/dev/null) ]]; then
        devenv tasks list 2>/dev/null | grep -oE '[a-z]+:[a-z0-9:-]+' | sort -u > "$cache" 2>/dev/null || true
      fi
      cat "$cache" 2>/dev/null
    }

    if [[ -n "$ZSH_VERSION" ]]; then
      _dt_completions() {
        local tasks
        tasks=("''${(@f)$(_dt_get_tasks)}")
        _describe 'task' tasks
      }
      compdef _dt_completions dt
    elif [[ -n "$BASH_VERSION" ]]; then
      _dt_completions() {
        local cur tasks
        cur="''${COMP_WORDS[COMP_CWORD]}"
        tasks=$(_dt_get_tasks)
        COMPREPLY=($(compgen -W "$tasks" -- "$cur"))
      }
      complete -F _dt_completions dt
    fi
  '';
}
