# Megarepo sync and workspace generation tasks.
#
# Uses the source CLI (`mr`) from the repo for speed in devenv shells.
# This assumes dependencies are installed (pnpm:install).
#
# Tasks:
# - megarepo:sync - Clone/update member repos and create symlinks
# - megarepo:generate - Generate .envrc.generated.megarepo and nix workspace
# - megarepo:check - Verify megarepo setup is complete and consistent
{ lib, pkgs, ... }:
{
  tasks."megarepo:sync" = {
    description = "Sync megarepo members (clone repos, create symlinks)";
    # Source CLI requires deps; keep bootstrap order predictable.
    after = [ "pnpm:install:megarepo" ];
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

      # Fast git+file: if repos/ doesn't exist, definitely need sync
      if [ ! -d ./repos ]; then
        exit 1
      fi

      # Use mr status to check syncNeeded field
      status_json=$(nix run "git+file:$PWD#megarepo" -- status --output json 2>/dev/null) || exit 1

      # Use the top-level syncNeeded boolean for a simple check
      echo "$status_json" | ${pkgs.jq}/bin/jq -e '.syncNeeded == false' >/dev/null 2>&1
    '';
  };

  tasks."megarepo:generate" = {
    description = "Generate megarepo envrc + workspace mirror";
    after = [ "megarepo:sync" ];
    exec = ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      mr generate nix --all
    '';
    status = ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      if [ ! -f ./.envrc.generated.megarepo ]; then
        exit 1
      fi

      if [ ./megarepo.json -nt ./.envrc.generated.megarepo ]; then
        exit 1
      fi

      if [ -f ./megarepo.lock ] && [ ./megarepo.lock -nt ./.envrc.generated.megarepo ]; then
        exit 1
      fi

      exit 0
    '';
  };
  tasks."megarepo:check" = {
    description = "Verify megarepo envrc + workspace mirror are present and consistent";
    # Use status to short-circuit when everything is already valid.
    # This keeps check:quick/ check:all fast by avoiding redundant work.
    # The status logic mirrors exec and returns non-zero only when a real issue exists.
    status = ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      if [ ! -f ./.envrc.generated.megarepo ]; then
        exit 1
      fi

      if [ ! -f ./.direnv/megarepo-nix/workspace/flake.nix ]; then
        exit 1
      fi

      if ! grep -q '^export MEGAREPO_ROOT_NEAREST' ./.envrc.generated.megarepo; then
        exit 1
      fi

      repo_root="$(pwd -P)/"
      if [ -n "''${MEGAREPO_ROOT_NEAREST:-}" ]; then
        nearest="''${MEGAREPO_ROOT_NEAREST%/}/"
        if [ "$nearest" != "$repo_root" ]; then
          exit 1
        fi
      fi

      exit 0
    '';
    exec = ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      if [ ! -f ./.envrc.generated.megarepo ]; then
        echo "[devenv] Missing .envrc.generated.megarepo." >&2
        echo "[devenv] Fix: mr generate nix && direnv reload" >&2
        echo "[devenv] Or:  devenv tasks run megarepo:generate" >&2
        exit 1
      fi

      if [ ! -f ./.direnv/megarepo-nix/workspace/flake.nix ]; then
        echo "[devenv] Missing .direnv/megarepo-nix/workspace/flake.nix." >&2
        echo "[devenv] Fix: mr generate nix && direnv reload" >&2
        echo "[devenv] Or:  devenv tasks run megarepo:generate" >&2
        exit 1
      fi

      repo_root="$(pwd -P)/"
      if ! grep -q '^export MEGAREPO_ROOT_NEAREST' ./.envrc.generated.megarepo; then
        echo "[devenv] MEGAREPO_ROOT_NEAREST export missing in .envrc.generated.megarepo." >&2
        echo "[devenv] Fix: mr generate nix && direnv reload" >&2
        exit 1
      fi

      if [ -n "''${MEGAREPO_ROOT_NEAREST:-}" ]; then
        nearest="''${MEGAREPO_ROOT_NEAREST%/}/"
        if [ "$nearest" != "$repo_root" ]; then
          echo "[devenv] MEGAREPO_ROOT_NEAREST mismatch." >&2
          echo "[devenv] Expected: $repo_root" >&2
          echo "[devenv] Found:    $nearest" >&2
          echo "[devenv] Fix: run from the repo root, then: mr generate nix && direnv reload" >&2
          exit 1
        fi
      fi
    '';
  };
}
