#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${DEVENV_ROOT:-$(cd "$TESTS_DIR/../../../../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

exec "$NODE_BIN" "$ROOT/scripts/devenv-task-graph-check.mjs" "$ROOT"
