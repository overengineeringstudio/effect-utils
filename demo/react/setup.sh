#!/usr/bin/env bash
# BACKSTAGE ONLY (not shown on camera).
#
# Prepares the notion-react demo:
#   1. Ensures the stage can resolve deps (symlinks the package's node_modules).
#   2. Creates ONE stable target Notion page under $DEMO_PARENT_PAGE.
#   3. Writes the page id to demo/react/.demo-state/page-id.
#   4. Clears the persisted FsCache so the first on-camera run is a clean cold sync.
#
# Idempotent: re-running reuses the existing page id if present (use reset.sh to
# start from a fresh page). Requires NOTION_API_TOKEN in the environment
# (provided by `devenv shell`) and $DEMO_PARENT_PAGE set to a page the token can
# write under.
set -euo pipefail

DEMO_REACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEMO_REACT_DIR/../.." && pwd)"
STAGE_DIR="$DEMO_REACT_DIR/stage"
STATE_DIR="$DEMO_REACT_DIR/.demo-state"
PKG_DIR="$REPO_ROOT/packages/@overeng/notion-react"

: "${DEMO_PARENT_PAGE:?set DEMO_PARENT_PAGE to a Notion page id the token can write under}"
: "${NOTION_API_TOKEN:?NOTION_API_TOKEN is not set (run inside 'devenv shell')}"

if [[ ! -d "$PKG_DIR/node_modules/effect" ]]; then
  echo "error: $PKG_DIR/node_modules is missing — run 'devenv tasks run pnpm:install' first" >&2
  exit 1
fi

# 1. Dep resolution for the out-of-package stage + bin scripts. One symlink at
#    demo/react/node_modules is reachable by both stage/*.tsx and bin/*.ts.
ln -sfn ../../packages/@overeng/notion-react/node_modules "$DEMO_REACT_DIR/node_modules"

mkdir -p "$STATE_DIR"

# 2 + 3. Create the target page (once) and record its id.
if [[ -s "$STATE_DIR/page-id" ]]; then
  echo "reusing existing page id: $(cat "$STATE_DIR/page-id")"
else
  echo "creating target page under $DEMO_PARENT_PAGE ..."
  PAGE_ID="$(
    DEMO_PARENT_PAGE="$DEMO_PARENT_PAGE" NOTION_API_TOKEN="$NOTION_API_TOKEN" \
      bun run "$DEMO_REACT_DIR/bin/create-page.ts"
  )"
  echo "$PAGE_ID" > "$STATE_DIR/page-id"
  echo "created page id: $PAGE_ID"
fi

# 4. Clean cache so the first on-camera run is a cold sync.
rm -f "$STATE_DIR/notion-cache.json"

echo
echo "ready. open the page in a browser:"
echo "  https://www.notion.so/$(tr -d - < "$STATE_DIR/page-id")"
