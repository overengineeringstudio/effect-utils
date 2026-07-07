#!/usr/bin/env bash
# BACKSTAGE ONLY — never shown on camera.
#
# Re-seed the `notion md` demo to a clean, repeatable slate:
#   1. trash the two Notion pages from the previous run (ids in .demo-state/),
#   2. restore clean working copies of seed/*.nmd into stage/,
#   3. create two FRESH Notion pages under $DEMO_PARENT_PAGE,
#   4. bind each: roadmap.nmd as `source: shared`, spec.nmd as `source: remote`,
#   5. verify both report `in-sync`, then print the fresh page URLs.
#
# Why the source flip? A committed seed cannot carry a real page id (public
# repo) and the `.nmd` schema rejects `source: shared|remote` with a null
# page_id. So the seed is `source: local` + `page_id: null` (the only legal
# unbound shape / create-on-push), and this script converts each file to its
# demo source with `notion md track ... --as <source>` right after creation.
#
# Idempotent / re-runnable: every run trashes the prior pages and creates fresh
# ones (a fresh page per run beats mutating one in place).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../bin/env.sh"

SEED_DIR="$SCRIPT_DIR/seed"
STAGE_DIR="$SCRIPT_DIR/stage"
STATE_DIR="$SCRIPT_DIR/.demo-state"
PLACEHOLDER_PARENT="00000000-0000-4000-8000-000000000000"

# `ntn` (Notion CLI) is used only to trash prior pages. Non-fatal if absent.
NTN_BIN="${NTN:-ntn}"

fail() { echo "reset: $*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
[[ -n "${NOTION_API_TOKEN:-}" ]] || fail "NOTION_API_TOKEN is not set (needed to create/track pages)"
[[ "${DEMO_PARENT_PAGE:-SET_ME}" != "SET_ME" ]] || fail "DEMO_PARENT_PAGE is not set — export the demo parent page id first"
[[ -f "$REPO_ROOT/packages/@overeng/notion-md/dist/src/cli.js" ]] \
  || fail "notion-md is not built — run: devenv tasks run ts:build"

# Normalize a 32-hex or dashed Notion id to canonical dashed 8-4-4-4-12.
dash_uuid() {
  local s="${1//-/}"
  printf '%s-%s-%s-%s-%s\n' "${s:0:8}" "${s:8:4}" "${s:12:4}" "${s:16:4}" "${s:20:12}"
}

PARENT_ID="$(dash_uuid "$DEMO_PARENT_PAGE")"

# Read a top-level `"key": "value"` string out of an .nmd frontmatter block.
nmd_field() { # <file> <key>
  grep -m1 "\"$2\"" "$1" | sed -E "s/.*\"$2\": *\"([^\"]+)\".*/\1/"
}

# --- 1. trash the previous run's pages -------------------------------------
if [[ -d "$STATE_DIR" ]]; then
  for idfile in "$STATE_DIR"/*.id; do
    [[ -e "$idfile" ]] || continue
    old_id="$(cat "$idfile")"
    [[ -n "$old_id" ]] || continue
    if command -v "$NTN_BIN" >/dev/null 2>&1; then
      echo "reset: trashing prior page $old_id"
      "$NTN_BIN" pages trash "$old_id" --yes >/dev/null 2>&1 \
        || echo "reset: (could not trash $old_id — already gone?)" >&2
    else
      echo "reset: '$NTN_BIN' not on PATH; leaving prior page $old_id (trash it by hand)" >&2
    fi
  done
fi

# --- 2. restore clean stage from seed --------------------------------------
rm -rf "$STAGE_DIR/.notion-md"
rm -f "$STAGE_DIR"/*.nmd "$STAGE_DIR"/*.conflict.roughdraft.md
mkdir -p "$STAGE_DIR" "$STATE_DIR"

for name in roadmap spec; do
  # Copy the seed and inject the real parent id (kept out of the committed seed).
  sed "s/$PLACEHOLDER_PARENT/$PARENT_ID/" "$SEED_DIR/$name.nmd" > "$STAGE_DIR/$name.nmd"
done

# --- 3+4. create fresh pages and bind each to its demo source --------------
bind() { # <name> <source>
  local name="$1" source="$2" file="$STAGE_DIR/$1.nmd" id url
  echo "reset: creating '$name' page ..."
  $NOTION_MD sync "$file" >/dev/null
  id="$(nmd_field "$file" page_id)"
  [[ -n "$id" ]] || fail "failed to create '$name' page (no page_id bound)"
  $NOTION_MD track "$id" "$file" --as "$source" >/dev/null
  url="$(nmd_field "$file" url)"
  printf '%s' "$id"  > "$STATE_DIR/$name.id"
  printf '%s' "$url" > "$STATE_DIR/$name.url"
  echo "reset:   $name ($source) -> $url"
}

bind roadmap shared
bind spec remote

# --- 5. verify clean slate -------------------------------------------------
echo "reset: verifying status ..."
$NOTION_MD status "$STAGE_DIR/roadmap.nmd" "$STAGE_DIR/spec.nmd"

cat <<EOF

reset: clean slate ready.
  stage:   $STAGE_DIR
  roadmap: $(cat "$STATE_DIR/roadmap.url")   (source: shared — beats 1 & 3)
  spec:    $(cat "$STATE_DIR/spec.url")   (source: remote — beat 2)

Open BOTH page URLs in the browser before recording.
EOF
