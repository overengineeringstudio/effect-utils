# Beads devenv module — integrates beads issue tracking with devenv.
#
# v0.56+ requires an external `dolt sql-server` (embedded mode removed).
# This module manages the server lifecycle: auto-starts on shell entry,
# stops on exit. Sets BEADS_DIR so `bd` works from anywhere.
{ beadsPrefix, beadsRepoName, beadsRepoPath ? "repos/${beadsRepoName}" }:
{ pkgs, config, ... }:
let
  git = "${pkgs.git}/bin/git";
  dolt = "${pkgs.dolt}/bin/dolt";
  bdPackage = import ../../../beads.nix { inherit pkgs; };
  bd = "${bdPackage}/bin/bd";
  beadsRepoRelPath = beadsRepoPath;
in
{
  env.BEADS_DIR = "${config.devenv.root}/${beadsRepoRelPath}/.beads";

  tasks."beads:ensure" = {
    description = "Ensure beads Dolt server is running and database is initialized";
    after = [ "megarepo:sync" ];
    exec = ''
      if [ ! -d "$BEADS_DIR" ]; then
        echo "[beads] Beads repo not materialized, skipping."
        exit 0
      fi

      cd "''${BEADS_DIR%/.beads}"

      DOLT_DIR="$BEADS_DIR/dolt"
      PID_FILE="$DOLT_DIR/sql-server.pid"
      LOG_FILE="$DOLT_DIR/sql-server.log"

      # Start dolt sql-server if not already running
      # Uses --data-dir so dolt serves all databases under $BEADS_DIR/dolt/
      # (bd creates the database directory structure, e.g. dolt/<db-name>/.dolt/)
      if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "[beads] Dolt server already running (PID $(cat "$PID_FILE"))"
      else
        rm -f "$PID_FILE"
        echo "[beads] Starting Dolt sql-server on port 3307..."
        ${dolt} sql-server --port 3307 --host 127.0.0.1 --data-dir "$DOLT_DIR" >> "$LOG_FILE" 2>&1 &
        echo $! > "$PID_FILE"

        # Wait for server to be ready
        for i in $(seq 1 30); do
          if ${bd} dolt test --quiet 2>/dev/null; then
            echo "[beads] Dolt server ready."
            break
          fi
          sleep 0.2
        done
      fi

      # Bootstrap DB from JSONL on fresh checkout
      if [ -f "$BEADS_DIR/issues.jsonl" ]; then
        ${bd} list --quiet >/dev/null 2>&1 || true
      fi
    '';
    status = ''
      [ ! -d "$BEADS_DIR" ] && exit 0
      PID_FILE="$BEADS_DIR/dolt/sql-server.pid"
      [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
    '';
  };

  tasks."beads:stop" = {
    description = "Stop beads Dolt server";
    exec = ''
      PID_FILE="$BEADS_DIR/dolt/sql-server.pid"
      if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
          echo "[beads] Stopping Dolt server (PID $PID)..."
          kill "$PID" 2>/dev/null || true
          rm -f "$PID_FILE"
        fi
      else
        echo "[beads] Dolt server not running."
      fi
    '';
  };

  tasks."beads:push" = {
    description = "Push beads changes to Dolt remote";
    after = [ "megarepo:sync" ];
    exec = ''
      if [ ! -d "$BEADS_DIR" ]; then
        echo "[beads] Beads repo not found." >&2
        exit 1
      fi
      cd "''${BEADS_DIR%/.beads}"
      ${bd} dolt push 2>&1
    '';
  };

  tasks."beads:pull" = {
    description = "Pull beads changes from Dolt remote";
    after = [ "megarepo:sync" ];
    exec = ''
      if [ ! -d "$BEADS_DIR" ]; then
        echo "[beads] Beads repo not found." >&2
        exit 1
      fi
      cd "''${BEADS_DIR%/.beads}"
      ${bd} dolt pull 2>&1
    '';
  };

  git-hooks.hooks.beads-commit-correlation = {
    enable = true;
    entry = "${pkgs.writeShellScript "beads-post-commit" ''
      set -euo pipefail

      GIT_ROOT="$(${git} rev-parse --show-toplevel)"
      BEADS_REPO="''${GIT_ROOT}/${beadsRepoRelPath}"

      [ ! -d "$BEADS_REPO/.beads" ] && exit 0

      COMMIT_SHORT=$(${git} rev-parse --short HEAD)
      COMMIT_MSG=$(${git} log -1 --format=%B)
      REPO_NAME=$(basename "$GIT_ROOT")

      ISSUES=$(echo "$COMMIT_MSG" | grep -oE "\(${beadsPrefix}-[a-z0-9]+\)" | tr -d '()' || true)

      [ -z "$ISSUES" ] && exit 0

      for issue_id in $ISSUES; do
        comment="Commit ''${COMMIT_SHORT} in ''${REPO_NAME}: ''${COMMIT_MSG%%$'\n'*}"
        (cd "$BEADS_REPO" && ${bd} comment "$issue_id" "$comment") 2>/dev/null || true
      done
    ''}";
    stages = ["post-commit"];
    always_run = true;
    pass_filenames = false;
  };
}
