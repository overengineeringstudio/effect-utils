#!/usr/bin/env bash
#
# BACKSTAGE ONLY — never shown on camera.
#
# Creates the synthetic, fully-typed Notion databases that the
# `notion schema generate` / `generate-config` / `diff` demo introspects on
# camera. All content is SYNTHETIC (this is a PUBLIC repo — never seed real
# workspace data).
#
# HONESTY: this uses `ntn api` to CREATE the databases. The `notion` schema
# tooling shown on camera is introspect -> codegen -> drift *detection*; it does
# NOT provision or alter the Notion DB from TypeScript. DB creation lives here.
#
# Creates two databases under $DEMO_PARENT_PAGE:
#   - "People" — title, select (Role), email, checkbox.
#     The relation target for Tasks.Assignee.
#   - "Tasks"  — title, status, select, multi_select, date,
#     number, checkbox, url, rich_text, relation (Assignee -> People).
#
# Captures the created database ids into demo/schema/.demo-state/ (gitignored)
# so the committed config and the README/SCREENPLAY commands can read them with
# no manual substitution. Pair with reset.sh (which trashes the previous DBs
# and generated files first) for a clean, repeatable state.
#
# Requires: `ntn` authenticated (external), `jq`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../bin/env.sh"

if [[ "${DEMO_PARENT_PAGE:-SET_ME}" == "SET_ME" || -z "${DEMO_PARENT_PAGE:-}" ]]; then
  echo "error: DEMO_PARENT_PAGE is not set." >&2
  echo "       Export a Notion page id shared with the 'Notion CLI' integration, e.g.:" >&2
  echo "       DEMO_PARENT_PAGE=396e3d41f4a380a98491e1c96f6b5c43 bash demo/schema/setup.sh" >&2
  exit 1
fi

STATE_DIR="$HERE/.demo-state"
mkdir -p "$STATE_DIR"

echo "==> Creating synthetic demo databases under page $DEMO_PARENT_PAGE"

# -----------------------------------------------------------------------------
# 1. People database (relation target)
# -----------------------------------------------------------------------------
people_resp=$(ntn api /v1/databases -X POST -d @- <<JSON
{
  "parent": { "type": "page_id", "page_id": "$DEMO_PARENT_PAGE" },
  "title": [{ "type": "text", "text": { "content": "People" } }],
  "icon": { "type": "emoji", "emoji": "👤" },
  "initial_data_source": {
    "properties": {
      "Name": {
        "type": "title", "title": {},
        "description": "Full name of the person"
      },
      "Role": {
        "type": "select",
        "description": "Primary role on the team",
        "select": { "options": [
          { "name": "Engineer", "color": "blue" },
          { "name": "Designer", "color": "purple" },
          { "name": "PM",       "color": "green" }
        ]}
      },
      "Email": {
        "type": "email", "email": {},
        "description": "Contact email address"
      },
      "Active": {
        "type": "checkbox", "checkbox": {},
        "description": "Whether the person is currently active"
      }
    }
  }
}
JSON
)

people_db_id=$(printf '%s' "$people_resp" | jq -r '.id // empty')
people_ds_id=$(printf '%s' "$people_resp" | jq -r '.data_sources[0].id // empty')
people_url=$(printf '%s' "$people_resp" | jq -r '.url // empty')
if [[ -z "$people_db_id" || -z "$people_ds_id" ]]; then
  echo "error: failed to create People database:" >&2
  printf '%s\n' "$people_resp" | jq -r '.message // .' >&2
  exit 1
fi
echo "    People db=$people_db_id ds=$people_ds_id"

# Seed a couple of people rows (best-effort; rows are optional for schema gen).
seed_person() {
  local name="$1" role="$2" email="$3" active="$4"
  ntn api /v1/pages -X POST -d @- >/dev/null 2>&1 <<JSON || echo "    (warn) people row '$name' failed" >&2
{
  "parent": { "type": "data_source_id", "data_source_id": "$people_ds_id" },
  "properties": {
    "Name":   { "title": [{ "type": "text", "text": { "content": "$name" } }] },
    "Role":   { "select": { "name": "$role" } },
    "Email":  { "email": "$email" },
    "Active": { "checkbox": $active }
  }
}
JSON
}
seed_person "Ada Lovelace"   "Engineer" "ada@example.com"   true
seed_person "Grace Hopper"   "PM"       "grace@example.com" true
seed_person "Alan Turing"    "Designer" "alan@example.com"  false

# Grab people page ids to reference from Tasks relations (best-effort).
mapfile -t people_page_ids < <(ntn datasources query "$people_ds_id" --json 2>/dev/null | jq -r '.results[].id' | head -3 || true)

# -----------------------------------------------------------------------------
# 2. Tasks database (the star of the demo)
# -----------------------------------------------------------------------------
tasks_resp=$(ntn api /v1/databases -X POST -d @- <<JSON
{
  "parent": { "type": "page_id", "page_id": "$DEMO_PARENT_PAGE" },
  "title": [{ "type": "text", "text": { "content": "Tasks" } }],
  "icon": { "type": "emoji", "emoji": "✅" },
  "initial_data_source": {
    "properties": {
      "Name": {
        "type": "title", "title": {},
        "description": "Short, human-readable task name"
      },
      "Status": {
        "type": "status", "status": {},
        "description": "Workflow state of the task"
      },
      "Priority": {
        "type": "select",
        "description": "How urgent this task is",
        "select": { "options": [
          { "name": "High",   "color": "red" },
          { "name": "Medium", "color": "yellow" },
          { "name": "Low",    "color": "gray" }
        ]}
      },
      "Tags": {
        "type": "multi_select",
        "description": "Areas of the codebase this task touches",
        "multi_select": { "options": [
          { "name": "Frontend", "color": "blue" },
          { "name": "Backend",  "color": "green" },
          { "name": "Design",   "color": "purple" },
          { "name": "Bug",      "color": "red" }
        ]}
      },
      "Due": {
        "type": "date", "date": {},
        "description": "Target completion date"
      },
      "Estimate": {
        "type": "number",
        "description": "Estimated effort in hours",
        "number": { "format": "number" }
      },
      "Done": {
        "type": "checkbox", "checkbox": {},
        "description": "Whether the task is complete"
      },
      "Spec": {
        "type": "url", "url": {},
        "description": "Link to the design doc or spec"
      },
      "Notes": {
        "type": "rich_text", "rich_text": {},
        "description": "Free-form context for the task"
      },
      "Assignee": {
        "type": "relation",
        "description": "The person responsible for this task",
        "relation": {
          "data_source_id": "$people_ds_id",
          "type": "single_property",
          "single_property": {}
        }
      }
    }
  }
}
JSON
)

tasks_db_id=$(printf '%s' "$tasks_resp" | jq -r '.id // empty')
tasks_ds_id=$(printf '%s' "$tasks_resp" | jq -r '.data_sources[0].id // empty')
tasks_url=$(printf '%s' "$tasks_resp" | jq -r '.url // empty')
if [[ -z "$tasks_db_id" || -z "$tasks_ds_id" ]]; then
  echo "error: failed to create Tasks database:" >&2
  printf '%s\n' "$tasks_resp" | jq -r '.message // .' >&2
  exit 1
fi
echo "    Tasks db=$tasks_db_id ds=$tasks_ds_id"

# Seed a few task rows (best-effort). Relations reference the people ids if we
# captured them; otherwise the rows are created without an Assignee link.
p0="${people_page_ids[0]:-}"
p1="${people_page_ids[1]:-}"
p2="${people_page_ids[2]:-}"

seed_task() {
  local name="$1" status="$2" priority="$3" tag="$4" due="$5" est="$6" done="$7" person="$8"
  local rel=""
  if [[ -n "$person" ]]; then
    rel=", \"Assignee\": { \"relation\": [{ \"id\": \"$person\" }] }"
  fi
  ntn api /v1/pages -X POST -d @- >/dev/null 2>&1 <<JSON || echo "    (warn) task row '$name' failed" >&2
{
  "parent": { "type": "data_source_id", "data_source_id": "$tasks_ds_id" },
  "properties": {
    "Name":     { "title": [{ "type": "text", "text": { "content": "$name" } }] },
    "Status":   { "status": { "name": "$status" } },
    "Priority": { "select": { "name": "$priority" } },
    "Tags":     { "multi_select": [{ "name": "$tag" }] },
    "Due":      { "date": { "start": "$due" } },
    "Estimate": { "number": $est },
    "Done":     { "checkbox": $done },
    "Notes":    { "rich_text": [{ "type": "text", "text": { "content": "Synthetic demo row." } }] }
    $rel
  }
}
JSON
}
seed_task "Wire up login form"      "In progress" "High"   "Frontend" "2026-07-14" 6  false "$p0"
seed_task "Cache invalidation bug"  "Not started" "High"   "Bug"      "2026-07-10" 3  false "$p1"
seed_task "Polish empty states"     "Done"        "Low"    "Design"   "2026-07-02" 2  true  "$p2"

# -----------------------------------------------------------------------------
# 3. Persist state for the committed config and the on-camera commands
# -----------------------------------------------------------------------------
printf '%s\n' "$tasks_db_id"  > "$STATE_DIR/tasks-db-id"
printf '%s\n' "$people_db_id" > "$STATE_DIR/people-db-id"
printf '%s\n' "$tasks_url"    > "$STATE_DIR/tasks-url"
printf '%s\n' "$people_url"   > "$STATE_DIR/people-url"

echo
echo "==> Done. Databases ready:"
echo "    Tasks:  $tasks_url"
echo "    People: $people_url"
echo
echo "State written to demo/schema/.demo-state/ (ids read by the config + commands)."
