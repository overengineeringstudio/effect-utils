# Reject exact duplicate locked identities within each configured flake lockfile.
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.flake-lock-duplicates {
#       lockfiles = [ "flake.lock" ];
#     })
#   ];
#
# Provides:
#   - nix:flake-lock:check-duplicates
{ lockfiles }:
{ pkgs, lib, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  checkDuplicatesScript = pkgs.writeShellScript "flake-lock-duplicates" ''
    set -euo pipefail

    diagnostics_file="$(${pkgs.coreutils}/bin/mktemp)"
    trap '${pkgs.coreutils}/bin/rm -f "$diagnostics_file"' EXIT

    for lockfile in ${lib.escapeShellArgs lockfiles}; do
      if [ ! -f "$lockfile" ]; then
        printf '%s: missing or not a regular file\n' "$lockfile" >> "$diagnostics_file"
        continue
      fi

      if duplicates="$(${pkgs.jq}/bin/jq -r --arg lockfile "$lockfile" '
        def valid_node:
          if type != "object" then false
          elif has("locked") then ((.locked | type) == "object")
          else true
          end;

        if type != "object" or ((.nodes | type) != "object") then
          error("invalid flake lock file")
        elif (([.nodes[] | valid_node] | all) | not) then
          error("invalid flake lock file")
        else
          [
            .nodes
            | to_entries[]
            | select(.value | has("locked"))
            | { name: .key, locked: .value.locked }
          ]
          | group_by(.locked)
          | map(select(length > 1) | map(.name) | sort)
          | sort_by(join("\u0000"))
          | .[]
          | "\($lockfile): exact duplicate locked identity in nodes: \(join(", "))"
        end
      ' "$lockfile" 2>/dev/null)"; then
        if [ -n "$duplicates" ]; then
          printf '%s\n' "$duplicates" >> "$diagnostics_file"
        fi
      else
        printf '%s: invalid flake lock file\n' "$lockfile" >> "$diagnostics_file"
      fi
    done

    if [ -s "$diagnostics_file" ]; then
      LC_ALL=C ${pkgs.coreutils}/bin/sort "$diagnostics_file"
      exit 1
    fi

    echo "No exact duplicate flake lock nodes found."
  '';
in
{
  tasks."nix:flake-lock:check-duplicates" = {
    description = "Reject exact duplicate locked identities within each flake lockfile";
    exec = trace.exec "nix:flake-lock:check-duplicates" "${checkDuplicatesScript}";
  };
}
