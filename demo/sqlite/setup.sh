#!/usr/bin/env bash
# BACKSTAGE ONLY — never shown on camera.
# Creates a fresh synthetic typed Notion database with seed rows under
# $DEMO_PARENT_PAGE, then records its ids/urls into demo/sqlite/.demo-state/.
# Idempotent in the sense that each run creates a brand-new fresh DB; use
# reset.sh to also trash the previous DB and (re)track a clean local stage.
#
# Requires: ntn (authenticated), python3, jq.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../bin/env.sh
source "$HERE/../bin/env.sh"

STATE_DIR="$HERE/.demo-state"
SEED_DIR="$HERE/seed"
mkdir -p "$STATE_DIR"

if [[ "${DEMO_PARENT_PAGE:-SET_ME}" == "SET_ME" ]]; then
  echo "setup: DEMO_PARENT_PAGE is not set. Export it first, e.g." >&2
  echo "  DEMO_PARENT_PAGE=396e3d41f4a380a98491e1c96f6b5c43 ./demo/sqlite/setup.sh" >&2
  exit 1
fi

echo "setup: creating synthetic 'Launch Tasks' database under parent $DEMO_PARENT_PAGE ..." >&2

# 1. Create the database + its initial data source with a typed schema.
DB_JSON="$(
  python3 - "$SEED_DIR/schema.json" "$DEMO_PARENT_PAGE" <<'PY'
import json, sys
schema = json.load(open(sys.argv[1]))
parent = sys.argv[2]
body = {
    "parent": {"type": "page_id", "page_id": parent},
    "title": [{"type": "text", "text": {"content": "Launch Tasks (sqlite demo)"}}],
    "initial_data_source": {"properties": schema["properties"]},
}
print(json.dumps(body))
PY
)"

DB_RESP="$(printf '%s' "$DB_JSON" | ntn api v1/databases)"
DB_ID="$(printf '%s' "$DB_RESP" | jq -r '.id')"
DB_URL="$(printf '%s' "$DB_RESP" | jq -r '.url')"
DS_ID="$(printf '%s' "$DB_RESP" | jq -r '.data_sources[0].id')"

if [[ -z "$DB_ID" || "$DB_ID" == "null" || -z "$DS_ID" || "$DS_ID" == "null" ]]; then
  echo "setup: database create failed:" >&2
  printf '%s\n' "$DB_RESP" | jq '{object, code, message}' >&2 || printf '%s\n' "$DB_RESP" >&2
  exit 1
fi

echo "setup: created database $DB_ID (data source $DS_ID)" >&2

# 2. Insert seed rows as pages under the data source.
python3 - "$SEED_DIR/rows.json" "$DS_ID" <<'PY' | while IFS= read -r payload; do
import json, sys
rows = json.load(open(sys.argv[1]))
ds = sys.argv[2]
for r in rows:
    props = {
        "Name": {"title": [{"text": {"content": r["Name"]}}]},
        "Status": {"select": {"name": r["Status"]}},
        "Priority": {"number": r["Priority"]},
        "Team": {"select": {"name": r["Team"]}},
    }
    print(json.dumps({"parent": {"type": "data_source_id", "data_source_id": ds}, "properties": props}))
PY
  printf '%s' "$payload" | ntn api v1/pages >/dev/null
  echo "setup: seeded row" >&2
done

# 3. Record durable ids for the on-camera flow (read from .demo-state).
#    The local replica path (data/v1/<ds-id>.sqlite) is written by reset.sh
#    after `notion db track` establishes the stage workspace.
printf '%s' "$DB_ID"  > "$STATE_DIR/database-id"
printf '%s' "$DS_ID"  > "$STATE_DIR/ds-id"
printf '%s' "$DB_URL" > "$STATE_DIR/database-url"

echo "setup: done." >&2
echo "  database-id : $DB_ID" >&2
echo "  ds-id       : $DS_ID" >&2
echo "  database-url: $DB_URL" >&2
