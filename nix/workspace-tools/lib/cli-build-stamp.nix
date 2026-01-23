# Helper for consistent runtime stamps across flake/dev shells.
# Arguments:
# - pkgs: Nixpkgs set providing coreutils + git.
{ pkgs }:

let
  package = pkgs.writeShellApplication {
    name = "cli-build-stamp";
    runtimeInputs = [ pkgs.coreutils pkgs.git ];
    text = ''
      set -euo pipefail
      rev=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
      tz=$(date +%z)
      tz_formatted="''${tz%??}:''${tz#???}"
      ts="$(date +%Y-%m-%dT%H:%M:%S)''${tz_formatted}"
      stamp="$rev+$ts"
      if [ "$rev" != "unknown" ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        stamp="$stamp-dirty"
      fi
      echo "$stamp"
    '';
  };
  shellHook = ''
    export NIX_CLI_BUILD_STAMP="$(${package}/bin/cli-build-stamp)"
  '';
in
{
  inherit package shellHook;
}
