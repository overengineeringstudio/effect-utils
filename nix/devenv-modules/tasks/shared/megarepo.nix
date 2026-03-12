# Megarepo sync tasks.
#
# Uses the `mr` CLI for megarepo operations.
#
# Tasks:
# - megarepo:sync - Reconcile repos/ to megarepo.json refs without touching megarepo.lock
# - megarepo:lock:sync - Record the current synced workspace into megarepo.lock
# - megarepo:lock:update - Fetch/update refs and then write megarepo.lock
# - megarepo:lock:apply - Apply megarepo.lock exactly (CI / isolated stores)
# - megarepo:check - Verify megarepo setup is complete
#
# Options:
# - syncAll: Whether to use `--all` (recursive nested sync). Default: true.
#   Set to false in CI where root members are already synced and nested sync
#   may fail due to credential scoping or version mismatches.
# NOTE: No pnpm:install:megarepo dependency here — this shared module is used by
# repos where megarepo may be a Nix package (no pnpm install needed). Repos that
# use source-mode megarepo via pnpm should add the dependency in their devenv.nix:
#   tasks."megarepo:sync".after = [ "pnpm:install:megarepo" ];
{
  syncAll ? true,
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
in
{
  # mr shells out to git for clone/fetch/worktree operations
  packages = [
    pkgs.git
    pkgs.openssh
  ];
  tasks."megarepo:sync" = {
    description = "Sync megarepo members to megarepo.json refs";
    exec = trace.exec "megarepo:sync" ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      mr sync${if syncAll then " --all" else ""}
    '';
    # Status: use `mr status --output json` to detect if workspace reconciliation is needed.
    status = trace.status "megarepo:sync" "binary" ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      # Fast check: if repos/ doesn't exist, definitely need sync
      if [ ! -d ./repos ]; then
        exit 1
      fi

      # Use mr status to check the workspace-specific boolean
      status_json=$(nix run "git+file:$PWD#megarepo" -- status --output json 2>/dev/null) || exit 1

      echo "$status_json" | ${pkgs.jq}/bin/jq -e '(.workspaceSyncNeeded // false) == false' >/dev/null 2>&1
    '';
  };

  tasks."megarepo:lock:sync" = {
    description = "Write megarepo.lock from the current synced workspace";
    exec = trace.exec "megarepo:lock:sync" ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      mr lock sync${if syncAll then " --all" else ""}
    '';
  };

  tasks."megarepo:lock:update" = {
    description = "Fetch refs, update workspace, and write megarepo.lock";
    exec = trace.exec "megarepo:lock:update" ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      mr lock update${if syncAll then " --all" else ""}
    '';
  };

  tasks."megarepo:lock:apply" = {
    description = "Apply megarepo.lock exactly";
    exec = trace.exec "megarepo:lock:apply" ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      mr lock apply${if syncAll then " --all" else ""}
    '';
  };

  tasks."megarepo:check" = {
    description = "Verify megarepo setup is complete";
    after = [ "megarepo:sync" ];
    # Check that repos dir exists and all members have symlinks
    status = trace.status "megarepo:check" "path" ''
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
