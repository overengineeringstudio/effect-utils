# Beads devenv module — integrates beads issue tracking with devenv.
#
# Since beads v0.51, the daemon and SQLite backend have been removed.
# Beads now uses Dolt as the sole backend. In embedded mode (default),
# bd manages the database directly — no server needed. In server mode,
# `bd dolt start` runs a Dolt SQL server for multi-writer concurrency.
#
# Sync is handled via `bd dolt push/pull` (JSONL sync layer was removed).
# JSONL is still maintained for git portability via `bd hooks install`,
# but Dolt is the source of truth.
#
# Exported env var:
# - BEADS_DIR: upstream bd env var for .beads discovery
# With this set, `bd` works from anywhere without wrapper scripts.
#
# Provides:
# - beads:ensure task — bootstraps Dolt DB on cold start
# - beads:push task — push via `bd dolt push`
# - beads:pull task — pull via `bd dolt pull`
# - beads-commit-correlation git hook — cross-references commits with beads issues
{ beadsPrefix, beadsRepoName, beadsRepoPath ? "repos/${beadsRepoName}" }:
{ pkgs, config, ... }:
let
  git = "${pkgs.git}/bin/git";
  bdPackage = import ../../../beads.nix { inherit pkgs; };
  bd = "${bdPackage}/bin/bd";
  beadsRepoRelPath = beadsRepoPath;
in
{
  env.BEADS_DIR = "${config.devenv.root}/${beadsRepoRelPath}/.beads";

  tasks."beads:ensure" = {
    description = "Ensure beads database is initialized";
    after = [ "megarepo:sync" ];
    exec = ''
      if [ ! -d "$BEADS_DIR" ]; then
        echo "[beads] Beads repo not materialized, skipping."
        exit 0
      fi

      cd "''${BEADS_DIR%/.beads}"

      # Cold-start: bootstrap Dolt DB from JSONL on fresh checkout.
      # `bd list` auto-creates the DB from JSONL as a side effect.
      if [ ! -d "$BEADS_DIR/dolt" ] && [ -f "$BEADS_DIR/issues.jsonl" ]; then
        echo "[beads] No database found, bootstrapping from JSONL..."
        ${bd} list --quiet >/dev/null 2>&1 || true
      fi
    '';
    status = ''
      [ ! -d "$BEADS_DIR" ] && exit 0
      [ -d "$BEADS_DIR/dolt" ]
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
