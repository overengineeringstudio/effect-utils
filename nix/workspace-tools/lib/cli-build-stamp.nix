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
      ts=$(date +%s)
      dirty="false"
      if [ "$rev" != "unknown" ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        dirty="true"
      fi
      # Output JSON: {"source":"local","rev":"...","ts":...,"dirty":...}
      echo "{\"source\":\"local\",\"rev\":\"$rev\",\"ts\":$ts,\"dirty\":$dirty}"
    '';
  };
  shellHook = ''
    export NIX_CLI_BUILD_STAMP="$(${package}/bin/cli-build-stamp)"
  '';
in
{
  inherit package shellHook;
}
