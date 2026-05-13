# Beads task module.
#
# Provides:
# - beads:push - push beads Dolt changes to the remote
# - beads:pull - pull beads Dolt changes, initializing from issues.jsonl if needed
# - beads-commit-correlation git hook - comments on referenced beads issues
#
# This module intentionally does not build or export Beads. Consumers either
# provide `bd` on PATH or pass `bdPackage`/`bdCommand`.
{
  beadsPrefix,
  beadsRepoName,
  beadsRepoPath ? "repos/${beadsRepoName}",
  beadsRepoRef ? "main",
  bdPackage ? null,
  bdCommand ? if bdPackage == null then "bd" else "${bdPackage}/bin/bd",
}:
{
  lib,
  pkgs,
  config,
  ...
}:
let
  git = "${pkgs.git}/bin/git";
  bd = bdCommand;
  beadsRepoRelPath = beadsRepoPath;
in
{
  packages = lib.optional (bdPackage != null) bdPackage;

  env.BEADS_DIR = "${config.devenv.root}/${beadsRepoRelPath}/.beads";
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
    stages = [ "post-commit" ];
    always_run = true;
    pass_filenames = false;
  };
}
