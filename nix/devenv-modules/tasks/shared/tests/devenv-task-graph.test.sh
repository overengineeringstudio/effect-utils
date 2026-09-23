#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${DEVENV_ROOT:-$(cd "$TESTS_DIR/../../../../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

"$NODE_BIN" "$ROOT/scripts/devenv-task-graph-check.mjs" "$ROOT"

fixture="$(mktemp)"
trap 'rm -f "$fixture"' EXIT
cat > "$fixture" <<'EOF'
{
  "tasks": [
    { "name": "kept", "after": ["missing-upstream"] },
    { "name": "also-kept", "before": ["missing-downstream"] }
  ]
}
EOF

if DEVENV_TASKS_JSON="$fixture" DEVENV_TASK_GRAPH_DEPENDENCIES_ONLY=1 \
  "$NODE_BIN" "$ROOT/scripts/devenv-task-graph-check.mjs" "$ROOT"
then
  echo "FAIL: task graph checker accepted dependencies on undefined tasks" >&2
  exit 1
fi

cat > "$fixture" <<'EOF'
{
  "tasks": [
    { "name": "upstream", "before": ["downstream"] },
    { "name": "downstream", "after": ["upstream"] }
  ]
}
EOF

DEVENV_TASKS_JSON="$fixture" DEVENV_TASK_GRAPH_DEPENDENCIES_ONLY=1 \
  "$NODE_BIN" "$ROOT/scripts/devenv-task-graph-check.mjs" "$ROOT"
