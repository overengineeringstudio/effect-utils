# Beads devenv module — integrates beads issue tracking with devenv.
#
# Uses Dolt as backend. In embedded mode (default), bd manages the
# database directly. In server mode, `bd dolt start` runs a Dolt SQL
# server for multi-writer concurrency.
#
# Sets BEADS_DIR so `bd` works from anywhere without wrapper scripts.
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

      # Bootstrap Dolt DB from JSONL on fresh checkout
      # (`bd list` auto-creates the DB from JSONL as a side effect)
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
