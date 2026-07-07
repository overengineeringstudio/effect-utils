#!/usr/bin/env bash
# BACKSTAGE ONLY (not shown on camera).
#
# Returns the notion-react demo to a clean slate between takes:
#   1. Archives the previous target page (if any) so the workspace stays tidy.
#   2. Clears BOTH the recorded page id AND the persisted FsCache — a stale
#      cache pointing at an archived page would produce wrong op counts.
#   3. Re-runs setup.sh to create a fresh empty page + record its id.
#
# Re-runnable. Requires NOTION_API_TOKEN and $DEMO_PARENT_PAGE.
set -euo pipefail

DEMO_REACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEMO_REACT_DIR/../.." && pwd)"
STATE_DIR="$DEMO_REACT_DIR/.demo-state"
STAGE_FILE="$DEMO_REACT_DIR/stage/page.tsx"

: "${NOTION_API_TOKEN:?NOTION_API_TOKEN is not set (run inside 'devenv shell')}"

# Restore the on-camera JSX to its committed starting state so every take
# begins from the same content (only works once page.tsx is committed; no-op
# otherwise so an uncommitted stage isn't clobbered).
if git -C "$REPO_ROOT" ls-files --error-unmatch "$STAGE_FILE" >/dev/null 2>&1; then
  git -C "$REPO_ROOT" checkout -- "$STAGE_FILE"
  echo "restored stage/page.tsx to committed state"
else
  echo "note: stage/page.tsx is not committed yet — not restoring (revert edits manually between takes)"
fi

if [[ -s "$STATE_DIR/page-id" ]]; then
  OLD_ID="$(cat "$STATE_DIR/page-id")"
  echo "archiving previous page: $OLD_ID"
  NOTION_API_TOKEN="$NOTION_API_TOKEN" bun run "$DEMO_REACT_DIR/bin/archive-page.ts" "$OLD_ID" || true
fi

rm -f "$STATE_DIR/page-id" "$STATE_DIR/notion-cache.json"

exec "$DEMO_REACT_DIR/setup.sh"
