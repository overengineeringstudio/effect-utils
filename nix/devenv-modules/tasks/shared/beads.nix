# Beads devenv module — integrates beads issue tracking with devenv.
#
# When enableDaemon = true (default), runs beads with daemon mode:
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
# Environment variables (available in tasks, shell, and direnv):
# - BEADS_REPO  — path to the beads repo (e.g. $DEVENV_ROOT/repos/overeng-beads-public)
# - BEADS_DIR   — path to .beads/ directory (bd uses this for database discovery)
# - BEADS_PREFIX — issue ID prefix (e.g. "oep")
#
# With BEADS_DIR set, `bd` works from anywhere — no wrapper script or shell
# function needed. This fixes direnv compatibility (shell functions don't
# survive direnv export) and removes the need to cd into the beads repo.
#
# Provides:
# - beads:daemon:ensure task — starts daemon if not running (idempotent)
# - beads:daemon:stop task — stops daemon (cleanup)
# - beads:sync task — commit + push JSONL changes to remote
# - beads-commit-correlation git hook — cross-references commits with beads issues
#
# Parameters:
#   beadsPrefix    — issue ID prefix (e.g. "oep")
#   beadsRepoName  — megarepo member name (e.g. "overeng-beads-public")
#   beadsRepoPath  — path to beads repo relative to devenv root
#                    (default: "repos/${beadsRepoName}" for megarepo members)
#   enableDaemon   — enable daemon mode with auto-sync (default: true)
#                    set to false for --no-db --no-daemon mode (legacy)
{ beadsPrefix, beadsRepoName, beadsRepoPath ? "repos/${beadsRepoName}", enableDaemon ? true }:
{ pkgs, config, ... }:
let
  beadsRepoRelPath = beadsRepoPath;
  beadsRepoAbsPath = "${config.devenv.root}/${beadsRepoRelPath}";
in
{
  # Environment variables available in tasks, shell, and direnv.
  # BEADS_DIR enables `bd` to discover the database from anywhere.
  env.BEADS_PREFIX = beadsPrefix;
  env.BEADS_REPO = beadsRepoAbsPath;
  env.BEADS_DIR = "${beadsRepoAbsPath}/.beads";

  # beads:daemon:ensure — Start daemon if not running. Idempotent: if another
  # workspace already started a daemon for this repo, this is a no-op.
  # The daemon auto-commits to the sync branch and auto-pulls from remote.
  # Git push is handled separately by beads:sync (see note in module header).
  tasks."beads:daemon:ensure" = {
    description = "Ensure beads daemon is running with auto-sync";
    after = [ "megarepo:sync" ];
    exec = if enableDaemon then ''
      if [ ! -d "$BEADS_DIR" ]; then
        echo "[beads] Beads repo not materialized, skipping daemon."
        exit 0
      fi

      cd "$BEADS_REPO"

      # If daemon already running (e.g. started by another workspace), skip
      if command bd daemon status >/dev/null 2>&1; then
        exit 0
      fi

      # Start daemon in background with auto-commit + auto-pull.
      # NOTE: --auto-push is not used because beads' upstream detection
      # doesn't work reliably in megarepo's bare+worktree git layout.
      # Git push is handled by the beads:sync task instead.
      command bd daemon start --auto-commit --auto-pull 2>&1 || true
    '' else ''
      exit 0
    '';
    status = if enableDaemon then ''
      [ ! -d "$BEADS_DIR" ] && exit 0
      cd "$BEADS_REPO"
      command bd daemon status >/dev/null 2>&1
    '' else "exit 0";
  };

  tasks."beads:daemon:stop" = {
    description = "Stop beads daemon";
    exec = ''
      [ ! -d "$BEADS_DIR" ] && exit 0
      cd "$BEADS_REPO"
      command bd daemons stop . 2>&1 || true
      echo "[beads] Daemon stopped."
    '';
  };

  # beads:sync — Push JSONL changes to remote.
  # With daemon mode, the daemon handles auto-commit to the sync branch
  # and auto-pull from remote. This task handles the git push that the
  # daemon can't do (see module header for details).
  tasks."beads:sync" = {
    description = "Sync beads: commit + push JSONL changes to remote";
    after = [ "megarepo:sync" ];
    exec = ''
      if [ ! -d "$BEADS_DIR" ]; then
        echo "[beads] Beads repo not found at ${beadsRepoRelPath}." >&2
        exit 1
      fi

      cd "$BEADS_REPO"

      # Pull remote changes first
      echo "[beads] Pulling remote changes..."
      git pull --rebase 2>&1 || true

      # Check if there are local changes to commit
      if git diff --quiet .beads/ 2>/dev/null && git diff --cached --quiet .beads/ 2>/dev/null; then
        echo "[beads] No changes to push."
        exit 0
      fi

      # Commit and push
      echo "[beads] Committing changes..."
      git add .beads/
      git commit -m "beads: sync issues" 2>&1

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
      BEADS_PREFIX="${beadsPrefix}"

      # Skip if beads repo doesn't exist
      [ ! -d "$BEADS_REPO/.beads" ] && exit 0

      # Get commit info
      COMMIT_SHORT=$(git rev-parse --short HEAD)
      COMMIT_MSG=$(git log -1 --format=%B)
      REPO_NAME=$(basename "$GIT_ROOT")

      # Extract issue references matching (prefix-xxx) pattern
      ISSUES=$(echo "$COMMIT_MSG" | grep -oE "\(''${BEADS_PREFIX}-[a-z0-9]+\)" | tr -d '()' || true)

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
