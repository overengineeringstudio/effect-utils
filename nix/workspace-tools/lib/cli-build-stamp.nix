# Helper for consistent runtime stamps across flake/dev shells.
# Generates a LocalStamp JSON for source-based CLI builds.
# Arguments:
# - pkgs: Nixpkgs set providing coreutils + git.
{ pkgs }:

let
  # Pure builds use source time, never an epoch fallback or ambient wall clock.
  mkNixStamp =
    {
      version,
      rev ? null,
      dirtyRev ? null,
      lastModified,
    }:
    let
      sourceRev = if rev != null then rev else dirtyRev;
    in
    assert sourceRev != null && builtins.match "[0-9a-f]{7,40}(-dirty)?" sourceRev != null;
    assert builtins.substring 0 7 sourceRev != "0000000";
    assert builtins.isInt lastModified && lastModified > 0;
    {
      type = "nix";
      inherit version;
      rev = builtins.substring 0 7 sourceRev;
      commitTs = lastModified;
      dirty = rev == null;
    };
  package = pkgs.writeShellApplication {
    name = "cli-build-stamp";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.git
    ];
    text = ''
      set -euo pipefail
      rev=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
      ts=$(date +%s)
      dirty="false"
      if [ "$rev" != "unknown" ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        dirty="true"
      fi
      # Output LocalStamp JSON
      echo "{\"type\":\"local\",\"rev\":\"$rev\",\"ts\":$ts,\"dirty\":$dirty}"
    '';
  };
  shellHook = ''
    export CLI_BUILD_STAMP="$(${package}/bin/cli-build-stamp)"
  '';
in
{
  inherit package shellHook mkNixStamp;
}
