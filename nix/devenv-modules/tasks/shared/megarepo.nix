# Megarepo sync tasks.
#
# Uses the `mr` CLI for megarepo operations.
#
# Tasks:
# - megarepo:sync - Clone/update member repos and create symlinks
# - megarepo:check - Verify megarepo setup is complete
#
# NOTE: No pnpm:install:megarepo dependency here — this shared module is used by
# repos where megarepo may be a Nix package (no pnpm install needed). Repos that
# use source-mode megarepo via pnpm should add the dependency in their devenv.nix:
#   tasks."megarepo:sync".after = [ "pnpm:install:megarepo" ];
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
in
{
  # mr shells out to git for clone/fetch/worktree operations
  packages = [ pkgs.git pkgs.openssh ];
  tasks."megarepo:sync" = {
    description = "Sync megarepo members (clone repos, create symlinks)";
    exec = trace.exec "megarepo:sync" ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      mr sync --all
    '';
    # Status: use `mr status --output json` to detect if sync is needed.
    # The CLI computes syncNeeded based on: missing symlinks/worktrees, symlink drift, lock staleness.
    status = trace.status "megarepo:sync" ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      # Fast check: if repos/ doesn't exist, definitely need sync
      if [ ! -d ./repos ]; then
        exit 1
      fi

      # Use mr status to check syncNeeded field
      status_json=$(nix run "git+file:$PWD#megarepo" -- status --output json 2>/dev/null) || exit 1

      # Use the top-level syncNeeded boolean for a simple check
      echo "$status_json" | ${pkgs.jq}/bin/jq -e '.syncNeeded == false' >/dev/null 2>&1
    '';
  };

  tasks."megarepo:check" = {
    description = "Verify megarepo setup is complete";
    after = [ "megarepo:sync" ];
    # Check that repos dir exists and all members have symlinks
    status = trace.status "megarepo:check" ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      # Check that repos directory exists
      if [ ! -d ./repos ]; then
        exit 1
      fi

      # Verify all configured members have symlinks in repos/
      members=$(${pkgs.jq}/bin/jq -r '.members | keys[]' ./megarepo.json 2>/dev/null) || exit 1
      for member in $members; do
        if [ ! -L "./repos/$member" ] && [ ! -d "./repos/$member" ]; then
          exit 1
        fi
      done

      exit 0
    '';
    exec = trace.exec "megarepo:check" ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      if [ ! -d ./repos ]; then
        echo "[devenv] Missing repos/ directory." >&2
        echo "[devenv] Fix: devenv tasks run megarepo:sync" >&2
        exit 1
      fi

      # Check for missing member symlinks
      missing=""
      members=$(${pkgs.jq}/bin/jq -r '.members | keys[]' ./megarepo.json 2>/dev/null) || exit 1
      for member in $members; do
        if [ ! -L "./repos/$member" ] && [ ! -d "./repos/$member" ]; then
          missing="$missing $member"
        fi
      done

      if [ -n "$missing" ]; then
        echo "[devenv] Missing member symlinks:$missing" >&2
        echo "[devenv] Fix: devenv tasks run megarepo:sync" >&2
        exit 1
      fi
    '';
  };
}
