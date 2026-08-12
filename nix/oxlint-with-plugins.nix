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
  runtimeInputs = [
    pkgs.jq
    pkgs.flock
  ];
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

      # Publish a persistent, git-ignored root cache atomically, and serialize
      # concurrent wrappers by locking the source config itself (without
      # creating another repository-local lock file). Keeping the complete file
      # avoids a hash-crawler stat/open race with an EXIT-time deletion.
      exec 9<"$config_file"
      flock --exclusive 9
      tmpconfig="$config_dir/.oxlint-with-plugins.json"
      staged_config=$(mktemp "''${TMPDIR:-/tmp}/oxlint-with-plugins.XXXXXX.json")
      trap 'rm -f "$staged_config"' EXIT
      jq --argjson plugins "[\"$pluginPath\"]" '.jsPlugins = $plugins' "$config_file" > "$staged_config"
      mv "$staged_config" "$tmpconfig"

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

      # Run as a child so the staged-file cleanup trap remains effective.
      status=0
      ${oxlintNpm}/bin/oxlint "''${new_args[@]}" || status=$?
      exit "$status"
    else
      exec ${oxlintNpm}/bin/oxlint "$@"
    fi
  '';
}
