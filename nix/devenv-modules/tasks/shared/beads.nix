# Beads devenv module — integrates beads issue tracking with devenv.
#
# v0.57+ self-manages dolt sql-server (auto-start with deterministic port).
# This module sets BEADS_DIR and provides push/pull convenience tasks.
{ beadsPrefix, beadsRepoName, beadsRepoPath ? "repos/${beadsRepoName}", beadsRepoRef ? "main" }:
{ pkgs, config, ... }:
let
  git = "${pkgs.git}/bin/git";
  bdPackage = import ../../../beads.nix {
    inherit pkgs;
    beadsPrimaryRef = beadsRepoRef;
  };
  bd = "${bdPackage}/bin/bd";
  beadsRepoRelPath = beadsRepoPath;
in
{
  env.BEADS_DIR = "${config.devenv.root}/${beadsRepoRelPath}/.beads";
  # TODO: Remove BEADS_PRIMARY_REF after beads#2439 is merged and adopted.
  # It is only threaded through today so the wrapper can rewrite detached
  # refs/commits worktrees back to a stable branch worktree.
  env.BEADS_PRIMARY_REF = beadsRepoRef;

  tasks."beads:push" = {
    description = "Push beads changes to Dolt remote";
    after = [ "mr:fetch-apply" ];
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
    after = [ "mr:fetch-apply" ];
    exec = ''
      if [ ! -d "$BEADS_DIR" ]; then
        echo "[beads] Beads repo not found." >&2
        exit 1
      fi
      cd "''${BEADS_DIR%/.beads}"

      # Auto-initialize from issues.jsonl if no Dolt database exists yet
      if [ ! -d "$BEADS_DIR/dolt" ]; then
        echo "[beads] No Dolt database found, initializing from issues.jsonl..."
        ${bd} init --force --from-jsonl --prefix ${beadsPrefix} 2>&1
        echo "[beads] Initialized with $(${bd} count 2>/dev/null || echo '?') issues"
        exit 0
      fi

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
