builtins.toFile "peer-envrc.sh" ''
  # Effect-utils direnv helper for peer repos.
  # Sources the auto-rebuild script and triggers CLI rebuilds when stale.
  #
  # Optional env overrides:
  # - NIX_CLI_PACKAGES / NIX_CLI_DIRTY_PACKAGES
  # - NIX_CLI_OUT_PATHS_ATTR / NIX_CLI_DIRTY_OUT_PATHS_ATTR
  # - NIX_CLI_FLAKE / NIX_CLI_WORKSPACE_ROOT
  # - NIX_CLI_RELOAD_CMD (override the reload command)

  if [ -z "''${WORKSPACE_ROOT:-}" ]; then
    export WORKSPACE_ROOT="$(pwd)"
  fi

  auto_rebuild_script_path="${import ./auto-rebuild-clis.nix}"
  if [ -n "$auto_rebuild_script_path" ] && [ -f "$auto_rebuild_script_path" ]; then
    source "$auto_rebuild_script_path"

    cli_flake="''${NIX_CLI_FLAKE:-$WORKSPACE_ROOT}"
    cli_workspace_root="''${NIX_CLI_WORKSPACE_ROOT:-$WORKSPACE_ROOT}"

    reload_cmd="''${NIX_CLI_RELOAD_CMD:-}"
    if [ -z "$reload_cmd" ]; then
      if declare -F use >/dev/null 2>&1; then
        if [ -f "$WORKSPACE_ROOT/devenv.nix" ] || [ -f "$WORKSPACE_ROOT/devenv.yaml" ]; then
          reload_cmd="use devenv"
        fi
      elif command -v devenv >/dev/null 2>&1; then
        if [ -f "$WORKSPACE_ROOT/devenv.nix" ] || [ -f "$WORKSPACE_ROOT/devenv.yaml" ]; then
          reload_cmd='eval "$(devenv print-dev-env)"'
        fi
      fi
    fi

    auto_rebuild_nix_clis_for_workspace "$cli_workspace_root" "$reload_cmd" "$cli_flake"
    unset -f auto_rebuild_nix_clis
    unset -f auto_rebuild_nix_clis_for_workspace
    unset -f prepare_cli_workspace
    unset -f prepare_cli_flake
  else
    echo "direnv: auto-rebuild helper script not found" >&2
  fi

  unset auto_rebuild_script_path
  unset cli_flake
  unset cli_workspace_root
''
