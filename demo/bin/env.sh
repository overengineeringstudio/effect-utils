#!/usr/bin/env bash
# Shared demo environment: resolves built CLI binaries and the demo Notion env.
# Source this from each primitive's run.sh:  source "$DEMO_ROOT/bin/env.sh"
set -euo pipefail

# Repo root = two levels up from this file (demo/bin/env.sh -> repo).
DEMO_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_ROOT="$(cd "$DEMO_BIN_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEMO_ROOT/.." && pwd)"

# Built CLI entrypoints (run `devenv tasks run ts:build` first).
NOTION_MD="node $REPO_ROOT/packages/@overeng/notion-md/dist/src/cli.js"
NOTION="node $REPO_ROOT/packages/@overeng/notion-cli/dist/cli.js"

# Demo working env. Override via env vars to repoint at the shared demo DB.
# DEMO_PARENT_PAGE: a page the ntn "Notion CLI" integration can write under.
# Default is a placeholder; set before recording.
: "${DEMO_PARENT_PAGE:=SET_ME}"

export DEMO_BIN_DIR DEMO_ROOT REPO_ROOT NOTION_MD NOTION DEMO_PARENT_PAGE
