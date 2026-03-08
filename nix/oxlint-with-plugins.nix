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
      tmpconfig=$(mktemp)
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

      exec ${oxlintNpm}/bin/oxlint "''${new_args[@]}"
    else
      exec ${oxlintNpm}/bin/oxlint "$@"
    fi
  '';
}
