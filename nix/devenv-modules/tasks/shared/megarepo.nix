# Megarepo tasks.
#
# Uses the `mr` CLI for megarepo operations.
#
# Tasks:
# - mr:sync - Fetch latest refs and apply to workspace (mr fetch --apply)
# - mr:lock - Record the current workspace into megarepo.lock (mr lock)
# - mr:fetch-apply - Fetch latest refs and apply (mr fetch --apply)
# - mr:apply - Apply megarepo.lock exactly (mr apply)
# - mr:check - Verify megarepo setup is complete
#
# Options:
# - syncAll: Whether to use `--all` (recursive nested sync). Default: true.
#   Set to false in CI where root members are already synced and nested sync
#   may fail due to credential scoping or version mismatches.
# NOTE: No pnpm:install:megarepo dependency here — this shared module is used by
# repos where megarepo may be a Nix package (no pnpm install needed). Repos that
# use source-mode megarepo via pnpm should add the dependency in their devenv.nix:
#   tasks."mr:sync".after = [ "pnpm:install:megarepo" ];
{
  syncAll ? true,
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };

  tasks = {
    "mr:sync" = {
      guard = "mr";
      description = "Fetch latest refs and apply to workspace";
      exec = trace.exec "mr:sync" ''
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        mr fetch --apply${if syncAll then " --all" else ""}
      '';
      # Status: use `mr status --output json` to detect if workspace reconciliation is needed.
      status = trace.status "mr:sync" "binary" ''
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
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

    "mr:lock" = {
      guard = "mr";
      description = "Record current workspace state into megarepo.lock";
      exec = trace.exec "mr:lock" ''
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        mr lock${if syncAll then " --all" else ""}
      '';
    };

    "mr:fetch-apply" = {
      description = "Fetch latest refs and apply to workspace";
      exec = trace.exec "mr:fetch-apply" ''
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        mr fetch --apply${if syncAll then " --all" else ""}
      '';
    };

    "mr:apply" = {
      guard = "mr";
      description = "Apply megarepo.lock to workspace";
      exec = trace.exec "mr:apply" ''
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        mr apply${if syncAll then " --all" else ""}
      '';
    };

    "mr:check" = {
      guard = "mr";
      description = "Verify megarepo setup is complete";
      after = [ "mr:sync" ];
      # Check that repos dir exists and all members have symlinks
      status = trace.status "mr:check" "path" ''
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        # Check that repos directory exists
        if [ ! -d ./repos ]; then
          exit 1
        fi

        # Verify all configured members have symlinks in repos/
        if [ -f ./megarepo.json ]; then
          members=$(${pkgs.jq}/bin/jq -r '.members | keys[]' ./megarepo.json 2>/dev/null) || exit 1
        elif [ -f ./megarepo.kdl ]; then
          members=$(${pkgs.gnused}/bin/sed -n '/^members {/,/^}/{ /^  /s/^  \([^ "]*\).*/\1/p }' ./megarepo.kdl 2>/dev/null) || exit 1
        else
          exit 1
        fi
        for member in $members; do
          if [ ! -L "./repos/$member" ] && [ ! -d "./repos/$member" ]; then
            exit 1
          fi
        done

        exit 0
      '';
      exec = trace.exec "mr:check" ''
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        if [ ! -d ./repos ]; then
          echo "[devenv] Missing repos/ directory." >&2
          echo "[devenv] Fix: devenv tasks run mr:sync" >&2
          exit 1
        fi

        # Check for missing member symlinks
        missing=""
        if [ -f ./megarepo.json ]; then
          members=$(${pkgs.jq}/bin/jq -r '.members | keys[]' ./megarepo.json 2>/dev/null) || exit 1
        elif [ -f ./megarepo.kdl ]; then
          members=$(${pkgs.gnused}/bin/sed -n '/^members {/,/^}/{ /^  /s/^  \([^ "]*\).*/\1/p }' ./megarepo.kdl 2>/dev/null) || exit 1
        else
          exit 1
        fi
        for member in $members; do
          if [ ! -L "./repos/$member" ] && [ ! -d "./repos/$member" ]; then
            missing="$missing $member"
          fi
        done

        if [ -n "$missing" ]; then
          echo "[devenv] Missing member symlinks:$missing" >&2
          echo "[devenv] Fix: devenv tasks run mr:sync" >&2
          exit 1
        fi
      '';
    };
  };
in
{
  # mr shells out to git for clone/fetch/worktree operations
  packages = [
    pkgs.git
    pkgs.openssh
  ] ++ cliGuard.fromTasks tasks;

  tasks = cliGuard.stripGuards tasks;
}
