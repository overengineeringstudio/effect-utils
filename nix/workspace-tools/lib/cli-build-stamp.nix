# Helper for consistent runtime stamps across flake/dev shells.
# Arguments:
# - pkgs: Nixpkgs set providing coreutils + git.
# - workspaceRoot: Optional workspace root to pin stamp generation.
{ pkgs, workspaceRoot ? null }:

let
  lib = pkgs.lib;
  # Optional pinned root for the stamp (useful when the workspace isn't CWD).
  stampRoot =
    if workspaceRoot == null
    then null
    else lib.escapeShellArg (toString workspaceRoot);
  package = pkgs.writeShellApplication {
    name = "cli-build-stamp";
    runtimeInputs = [ pkgs.coreutils pkgs.git ];
    text = ''
      set -euo pipefail
      root="''${CLI_BUILD_STAMP_ROOT:-''${WORKSPACE_ROOT:-$PWD}}"
      rev=$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo "unknown")
      tz=$(date +%z)
      tz_formatted="''${tz%??}:''${tz#???}"
      ts="$(date +%Y-%m-%dT%H:%M:%S)''${tz_formatted}"
      stamp="$rev+$ts"
      if [ "$rev" != "unknown" ] && [ -n "$(git -C "$root" status --porcelain 2>/dev/null)" ]; then
        stamp="$stamp-dirty"
      fi
      echo "$stamp"
    '';
  };
  shellHook = ''
    ${lib.optionalString (stampRoot != null) "export CLI_BUILD_STAMP_ROOT=${stampRoot}"}
    export NIX_CLI_BUILD_STAMP="$(${package}/bin/cli-build-stamp)"
  '';
in
{
  inherit package shellHook;
}
