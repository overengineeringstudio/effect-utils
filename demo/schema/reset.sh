#!/usr/bin/env bash
#
# BACKSTAGE ONLY — never shown on camera.
#
# Returns the schema demo to a clean, repeatable state:
#   1. Trashes the previously-created demo databases (ids in .demo-state).
#   2. Removes generated artifacts in stage/ (they are read-only by default).
#   3. Recreates the two synthetic databases via setup.sh.
#
# Idempotent: safe to run before every take. All content SYNTHETIC (PUBLIC repo).
#
# Requires: `ntn` authenticated (external), `jq`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../bin/env.sh"

STATE_DIR="$HERE/.demo-state"
STAGE_DIR="$HERE/stage"

# 1. Trash any databases recorded from a previous run (a Notion database is not
#    a "page", so `ntn pages trash` does not apply — use the databases endpoint).
if [[ -d "$STATE_DIR" ]]; then
  for idfile in "$STATE_DIR"/*-db-id; do
    [[ -e "$idfile" ]] || continue
    db_id="$(tr -d '[:space:]' < "$idfile")"
    [[ -n "$db_id" ]] || continue
    echo "==> Trashing previous database $db_id"
    ntn api "/v1/databases/$db_id" -X PATCH -d '{"in_trash":true}' >/dev/null 2>&1 \
      || echo "    (warn) could not trash $db_id (already gone?)" >&2
    rm -f "$idfile"
  done
  rm -f "$STATE_DIR"/*-url
fi

# 2. Remove generated schema/API files from the stage (chmod first: read-only).
if [[ -d "$STAGE_DIR" ]]; then
  find "$STAGE_DIR" -maxdepth 1 -type f \( -name '*.gen.ts' -o -name '*.api.ts' \) \
    -exec chmod u+w {} + 2>/dev/null || true
  rm -f "$STAGE_DIR"/*.gen.ts "$STAGE_DIR"/*.api.ts 2>/dev/null || true
fi

# 2b. Ensure the stage can resolve `effect` and `@overeng/*` for editor
#     autocomplete + typecheck. We borrow the notion-cli package's node_modules
#     (which links both) via a gitignored symlink.
mkdir -p "$STAGE_DIR"
ln -sfn ../../../packages/@overeng/notion-cli/node_modules "$STAGE_DIR/node_modules"

# 3. Recreate the synthetic databases.
echo "==> Recreating synthetic demo databases"
bash "$HERE/setup.sh"
