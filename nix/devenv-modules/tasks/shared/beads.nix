# Beads devenv module — integrates beads issue tracking with devenv.
#
# Runs beads in daemon mode:
# - Serializes concurrent access via RPC (safe for multiple workspaces)
# - Auto-flushes DB changes to JSONL (event-driven)
# - Auto-imports when JSONL is newer (e.g. after commit-correlation hook writes)
# - Auto-commits JSONL changes to the sync branch
# - Auto-pulls remote changes (every 30s)
#
# Git push is NOT handled by the daemon (upstream detection doesn't work
# reliably in bare+worktree git layouts). Use `dt beads:sync` to push.
#
# The SQLite DB is gitignored (.beads/.gitignore) — JSONL remains the
# git-portable source of truth. Multiple megarepo workspaces sharing the
# same store worktree share a single daemon instance.
#
# Only env var exported: BEADS_DIR (upstream bd env var for database discovery).
# With BEADS_DIR set, `bd` works from anywhere — no wrapper script or shell
# function needed. This works with direnv (env vars survive export).
#
# Provides:
# - beads:daemon:ensure task — starts daemon if not running (idempotent)
# - beads:daemon:stop task — stops daemon (cleanup)
# - beads:sync task — push JSONL changes to remote
# - beads-commit-correlation git hook — cross-references commits with beads issues
#
# Parameters:
#   beadsPrefix    — issue ID prefix (e.g. "oep"), used by commit correlation hook
#   beadsRepoName  — megarepo member name (e.g. "overeng-beads-public")
#   beadsRepoPath  — path to beads repo relative to devenv root
#                    (default: "repos/${beadsRepoName}" for megarepo members)
{ beadsPrefix, beadsRepoName, beadsRepoPath ? "repos/${beadsRepoName}" }:
{ pkgs, config, ... }:
let
  beadsRepoRelPath = beadsRepoPath;
in
{
  # BEADS_DIR — upstream bd env var for database discovery.
  # Available in tasks, shell, and direnv.
  env.BEADS_DIR = "${config.devenv.root}/${beadsRepoRelPath}/.beads";

  # beads:daemon:ensure — Start daemon if not running. Idempotent: if another
  # workspace already started a daemon for this repo, this is a no-op.
  # The daemon auto-commits to the sync branch and auto-pulls from remote.
  # Git push is handled separately by beads:sync (see note in module header).
  tasks."beads:daemon:ensure" = {
    description = "Ensure beads daemon is running with auto-sync";
    after = [ "megarepo:sync" ];
    exec = ''
      if [ ! -d "$BEADS_DIR" ]; then
        echo "[beads] Beads repo not materialized, skipping daemon."
        exit 0
      fi

      cd "''${BEADS_DIR%/.beads}"

      # If daemon already running (e.g. started by another workspace), skip
      if command bd daemon status >/dev/null 2>&1; then
        exit 0
      fi

      # Start daemon in background with auto-commit + auto-pull.
      # NOTE: --auto-push is not used because beads' upstream detection
      # doesn't work reliably in megarepo's bare+worktree git layout.
      # Git push is handled by the beads:sync task instead.
      command bd daemon start --auto-commit --auto-pull 2>&1 || true
    '';
    status = ''
      [ ! -d "$BEADS_DIR" ] && exit 0
      cd "''${BEADS_DIR%/.beads}"
      command bd daemon status >/dev/null 2>&1
    '';
  };

  tasks."beads:daemon:stop" = {
    description = "Stop beads daemon";
    exec = ''
      [ ! -d "$BEADS_DIR" ] && exit 0
      cd "''${BEADS_DIR%/.beads}"
      command bd daemons stop . 2>&1 || true
      echo "[beads] Daemon stopped."
    '';
  };

  # beads:sync — Push beads changes to remote.
  # The daemon handles auto-commit and auto-pull. This task handles git push
  # (daemon --auto-push doesn't work in bare+worktree git layout).
  # Includes safety commit for when daemon wasn't running.
  tasks."beads:sync" = {
    description = "Push beads changes to remote";
    after = [ "megarepo:sync" ];
    exec = ''
      if [ ! -d "$BEADS_DIR" ]; then
        echo "[beads] Beads repo not found." >&2
        exit 1
      fi

      cd "''${BEADS_DIR%/.beads}"

      # Safety: commit any uncommitted changes (in case daemon wasn't running)
      if ! git diff --quiet .beads/ 2>/dev/null || ! git diff --cached --quiet .beads/ 2>/dev/null; then
        git add .beads/
        git commit -m "beads: sync issues" 2>&1
      fi

      echo "[beads] Pushing..."
      git push 2>&1
      echo "[beads] Sync complete."
    '';
  };

  git-hooks.hooks.beads-commit-correlation = {
    enable = true;
    # Always use --no-daemon --no-db for the hook: it runs in git hook context
    # where BEADS_DIR may not be set. Writing directly to JSONL is fast and
    # reliable. The daemon auto-imports JSONL changes on its next poll.
    entry = "${pkgs.writeShellScript "beads-post-commit" ''
      set -euo pipefail

      GIT_ROOT="$(git rev-parse --show-toplevel)"
      BEADS_REPO="''${GIT_ROOT}/${beadsRepoRelPath}"

      # Skip if beads repo doesn't exist
      [ ! -d "$BEADS_REPO/.beads" ] && exit 0

      # Get commit info
      COMMIT_SHORT=$(git rev-parse --short HEAD)
      COMMIT_MSG=$(git log -1 --format=%B)
      REPO_NAME=$(basename "$GIT_ROOT")

      # Extract issue references matching (prefix-xxx) pattern
      ISSUES=$(echo "$COMMIT_MSG" | grep -oE "\(${beadsPrefix}-[a-z0-9]+\)" | tr -d '()' || true)

      [ -z "$ISSUES" ] && exit 0

      # Add comment to each referenced issue (uses --no-db mode for reliability)
      for issue_id in $ISSUES; do
        comment="Commit ''${COMMIT_SHORT} in ''${REPO_NAME}: ''${COMMIT_MSG%%$'\n'*}"
        (cd "$BEADS_REPO" && command bd --no-daemon --no-db comment "$issue_id" "$comment") 2>/dev/null || true
      done
    ''}";
    stages = ["post-commit"];
    always_run = true;
    pass_filenames = false;
  };
}
