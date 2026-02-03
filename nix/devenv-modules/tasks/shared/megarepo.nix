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
{
  tasks."megarepo:sync" = {
    description = "Sync megarepo members (clone repos, create symlinks)";
    exec = ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      mr sync --all
    '';
    # Status: use `mr status --output json` to detect if sync is needed.
    # The CLI computes syncNeeded based on: missing symlinks/worktrees, symlink drift, lock staleness.
    status = ''
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
    # Simple check: just verify megarepo.json exists and repos dir is present
    status = ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      # Check that repos directory exists (sync has been run)
      if [ ! -d ./repos ]; then
        exit 1
      fi

      exit 0
    '';
    exec = ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      if [ ! -d ./repos ]; then
        echo "[devenv] Missing repos/ directory." >&2
        echo "[devenv] Fix: devenv tasks run megarepo:sync" >&2
        exit 1
      fi
    '';
  };
}
