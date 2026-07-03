# Wrapper around oxlint-npm that auto-injects the @overeng/oxc-config JS plugin.
#
# When the project's .oxlintrc.json (or an explicit -c config) contains overeng/*
# rules, this wrapper transparently injects (or replaces) the plugin path
# via a temporary config copy. Projects without overeng rules get plain pass-through.
#
# Usage:
#   oxlintWithPlugins = import ./oxlint-with-plugins.nix { inherit pkgs; oxlintNpm = ...; };
#   # => provides `oxlint` on PATH with automatic plugin injection
{
  pkgs,
  oxlintNpm,
}:
assert oxlintNpm.pluginPath != null;
pkgs.writeShellApplication {
  name = "oxlint";
  runtimeInputs = [ pkgs.jq ];
  text = ''
    pluginPath="${oxlintNpm.pluginPath}"

    # Find the config file: explicit -c/--config arg, or default .oxlintrc.json
    config_file=""
    args=("$@")
    for ((i=0; i<''${#args[@]}; i++)); do
      case "''${args[$i]}" in
        -c|--config)
          config_file="''${args[$((i+1))]}"
          break
          ;;
      esac
    done
    if [ -z "$config_file" ] && [ -f .oxlintrc.json ]; then
      config_file=".oxlintrc.json"
    fi

    # If config has overeng rules, inject the Nix-built plugin path (replaces any existing jsPlugins)
    if [ -n "$config_file" ] && grep -q '"overeng/' "$config_file" 2>/dev/null; then
      # oxlint 1.39.0's experimental JS-plugin rules only apply to files located
      # UNDER the (injected) config file's directory. Writing the merged config to
      # the default mktemp location (/tmp, outside the repo tree) silently drops
      # every overeng/* plugin rule for files enumerated deeper in the repo (the CI
      # path passes explicit deep file paths). So we write the injected copy into
      # the SAME directory as the source config (repo root for the default
      # .oxlintrc.json), keeping it an ancestor of the lint targets so plugin rules
      # apply. Cleaned up on EXIT via trap.
      config_dir=$(dirname "$config_file")
      tmpconfig=$(mktemp "$config_dir/.oxlint-with-plugins.XXXXXX.json")
      trap 'rm -f "$tmpconfig"' EXIT
      jq --argjson plugins "[\"$pluginPath\"]" '.jsPlugins = $plugins' "$config_file" > "$tmpconfig"

      # Replace the config arg, or prepend -c if using default
      new_args=()
      replaced=false
      for ((i=0; i<''${#args[@]}; i++)); do
        case "''${args[$i]}" in
          -c|--config)
            new_args+=("''${args[$i]}" "$tmpconfig")
            ((i++))
            replaced=true
            ;;
          *)
            new_args+=("''${args[$i]}")
            ;;
        esac
      done
      if [ "$replaced" = false ]; then
        new_args=("-c" "$tmpconfig" "''${new_args[@]}")
      fi

      # NOTE: do NOT `exec` here. The injected config lives inside the repo tree
      # and must be removed by the EXIT trap above; `exec` would replace this
      # shell and the trap would never fire, leaking the temp config at repo root.
      # Run as a child, capture status, and exit (trap cleans up).
      status=0
      ${oxlintNpm}/bin/oxlint "''${new_args[@]}" || status=$?
      exit "$status"
    else
      exec ${oxlintNpm}/bin/oxlint "$@"
    fi
  '';
}
