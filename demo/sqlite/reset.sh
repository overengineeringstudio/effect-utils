#!/usr/bin/env bash
# BACKSTAGE ONLY — never shown on camera.
# One command to get a clean recording state:
#   1. trash the previously created demo DB (from .demo-state), if any
#   2. wipe the local stage workspace
#   3. create a fresh synthetic Notion DB + seed rows (setup.sh)
#   4. `notion db track --mode local` it into demo/sqlite/stage/  (backstage:
#      the workspace is established once, before recording, so the on-camera
#      beats start from a clean tracked replica)
#   5. record the on-camera paths into .demo-state/ and print the Notion URL to
#      open for the recording
#
# Fresh DB per run keeps takes clean and avoids orphaned state.
# Requires: ntn (authenticated), python3, jq, and the packaged `notion` binary
# on PATH (node:sqlite-backed replica runtime). Run from `devenv shell`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../bin/env.sh
source "$HERE/../bin/env.sh"

STATE_DIR="$HERE/.demo-state"
STAGE_DIR="$HERE/stage"

# The packaged `notion` binary routes `db` replica verbs (track/sync/export/…)
# to the Node-backed runtime with node:sqlite; nothing else to preload.
if ! command -v notion >/dev/null 2>&1; then
  echo "reset: 'notion' is not on PATH. Run this from 'devenv shell'." >&2
  exit 1
fi

# 1. Trash the previous demo database, if we recorded one.
if [[ -f "$STATE_DIR/database-id" ]]; then
  OLD_DB="$(cat "$STATE_DIR/database-id")"
  if [[ -n "$OLD_DB" ]]; then
    echo "reset: trashing previous demo database $OLD_DB ..." >&2
    printf '%s' '{"in_trash":true}' | ntn api -X PATCH "v1/databases/$OLD_DB" >/dev/null 2>&1 \
      || echo "reset: (previous DB already gone or not accessible; continuing)" >&2
  fi
fi

# 2. Wipe the local stage workspace so track starts clean.
mkdir -p "$STAGE_DIR"
rm -rf "$STAGE_DIR"/data "$STAGE_DIR"/.notion "$STAGE_DIR"/.notion-md 2>/dev/null || true
rm -f  "$STAGE_DIR"/*.sqlite "$STAGE_DIR"/*.sqlite-shm "$STAGE_DIR"/*.sqlite-wal 2>/dev/null || true

# 3. Create a fresh synthetic Notion database with seed rows.
bash "$HERE/setup.sh"

DB_ID="$(cat "$STATE_DIR/database-id")"
DS_ID="$(cat "$STATE_DIR/ds-id")"
DB_URL="$(cat "$STATE_DIR/database-url")"

# 4. Track it into the stage workspace as an authority=local replica.
#    --mode local: local SQLite edits are the authority and get pushed to Notion
#      on `notion db sync` (this is what makes the on-camera edit land remotely).
#    --no-materialize-bodies: skip page-body .nmd materialization (faster, and
#      the demo edits row properties, not bodies).
#    OTEL exporter unset: avoids a slow telemetry flush on establishment.
STAGE_PHYS="$(cd "$STAGE_DIR" && pwd -P)"
echo "reset: tracking data source $DS_ID into stage (mode=local) — this can take ~1-2 min ..." >&2
(
  cd "$STAGE_PHYS"
  env -u OTEL_EXPORTER_OTLP_ENDPOINT -u OTEL_EXPORTER_OTLP_PROTOCOL -u OTEL_EXPORTER_OTLP_TRACES_ENDPOINT \
    notion db track "$DS_ID" . --mode local --no-materialize-bodies
) >/dev/null

SQLITE_PATH="$STAGE_PHYS/data/v1/$DS_ID.sqlite"
if [[ ! -f "$SQLITE_PATH" ]]; then
  echo "reset: ERROR — expected replica not created at $SQLITE_PATH" >&2
  exit 1
fi

# 5. Record on-camera paths for copy-paste beats.
printf '%s' "$SQLITE_PATH" > "$STATE_DIR/sqlite-path"

echo >&2
echo "reset: READY." >&2
echo >&2
echo "  Open in browser : $DB_URL" >&2
echo "  Local replica   : $SQLITE_PATH" >&2
echo "  On camera, cd    : cd $STAGE_DIR" >&2
