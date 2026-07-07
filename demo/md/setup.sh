#!/usr/bin/env bash
# BACKSTAGE ONLY — first-time setup for the `notion md` demo.
#
# Ensures the CLI is built, then hands off to reset.sh for the clean seed.
# For every subsequent take you only need ./reset.sh.
#
# Usage (from a `devenv shell`, with NOTION_API_TOKEN + DEMO_PARENT_PAGE set):
#   DEMO_PARENT_PAGE=<parent-page-id> ./demo/md/setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../bin/env.sh"

if [[ ! -f "$REPO_ROOT/packages/@overeng/notion-md/dist/src/cli.js" ]]; then
  echo "setup: notion-md not built — building (devenv tasks run ts:build) ..."
  ( cd "$REPO_ROOT" && devenv tasks run ts:build --no-tui )
fi

echo "setup: seeding clean slate ..."
exec "$SCRIPT_DIR/reset.sh"
