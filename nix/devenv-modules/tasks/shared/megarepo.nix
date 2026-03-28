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
  cacheRoot = ".direnv/task-cache/mr-apply";
  membersFile = "${cacheRoot}/members.txt";
  recordWorkspaceMembers = ''
    set -o pipefail
    mkdir -p ${lib.escapeShellArg cacheRoot}
    tmp_members_file="$(mktemp)"
    # Rewrite the manifest atomically so a failed `mr ls` never leaves behind
    # an empty file that would make the warm-path output proof vacuous.
    mr ls --output json \
      | ${pkgs.jq}/bin/jq -r 'select(._tag == "Success") | .value.members[].name' \
      | LC_ALL=C sort -u > "$tmp_members_file"
    mv "$tmp_members_file" ${lib.escapeShellArg membersFile}
  '';
  mrStatusCheck = ''
    # Use the already-installed source CLI here. `nix run ...#megarepo` adds a
    # second eval/build hop to every warm status check.
    if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
      exit 0
    fi

    if [ "''${DEVENV_SETUP_OUTER_CACHE_HIT:-0}" = "1" ]; then
      [ -d ./repos ] || exit 1
      [ -f ${lib.escapeShellArg membersFile} ] || exit 1
      while IFS= read -r member; do
        [ -n "$member" ] || continue
        if [ ! -L "./repos/$member" ] && [ ! -d "./repos/$member" ]; then
          exit 1
        fi
      done < ${lib.escapeShellArg membersFile}
      exit 0
    fi

    if [ ! -d ./repos ]; then
      exit 1
    fi

    status_json=$(mr status --output json 2>/dev/null) || exit 1
    echo "$status_json" | ${pkgs.jq}/bin/jq -e '(.workspaceSyncNeeded // false) == false' >/dev/null 2>&1
  '';

  tasks = {
    "mr:sync" = {
      guard = "mr";
      description = "Fetch latest refs and apply to workspace";
      exec = trace.exec "mr:sync" ''
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        mr fetch --apply${if syncAll then " --all" else ""}
        ${recordWorkspaceMembers}
      '';
      status = trace.status "mr:sync" "binary" mrStatusCheck;
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
        ${recordWorkspaceMembers}
      '';
      status = trace.status "mr:apply" "binary" mrStatusCheck;
    };

    "mr:check" = {
      guard = "mr";
      description = "Verify megarepo setup is complete";
      after = [ "mr:sync" ];
      # Check that repos dir exists and all members have symlinks
      status = trace.status "mr:check" "path" ''
        set -o pipefail
        if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
          exit 0
        fi

        # Check that repos directory exists
        if [ ! -d ./repos ]; then
          exit 1
        fi

        # Verify all configured members have symlinks in repos/
        members=$(mr ls --output json | ${pkgs.jq}/bin/jq -r 'select(._tag == "Success") | .value.members[].name') || exit 1
        for member in $members; do
          if [ ! -L "./repos/$member" ] && [ ! -d "./repos/$member" ]; then
            exit 1
          fi
        done

        exit 0
      '';
      exec = trace.exec "mr:check" ''
        set -o pipefail
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
        members=$(mr ls --output json | ${pkgs.jq}/bin/jq -r 'select(._tag == "Success") | .value.members[].name') || exit 1
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
