#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${DEVENV_ROOT:-$(cd "$TESTS_DIR/../../../../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

# Validate the active profile: unit CI keeps the guard enabled, with narrowed
# expectations selected by the same job-level flag as devenv.nix.
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
  "$NODE_BIN" "$ROOT/scripts/devenv-task-graph-check.mjs" "$ROOT" >/dev/null 2>&1
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

# A narrowed graph must reject reintroduced non-unit tasks, not merely stop
# requiring them. These minimal fixtures fail before common required-task checks.
for forbidden_task in \
  storybook:build storybook:test:aggregate:utils \
  netlify:deploy netlify:stage:aggregate-build:utils \
  workflow-report:collect-bundle workflow-report:publish \
  test:pw:utils test:notion-integration test:notion-integration:notion-cli \
  test:restate-integration weaver:live-check \
  test:consumer-smoke test:megarepo-cold-gc \
  buck2:editor:publish:batch:storybook:test \
  buck2:editor:publish:consumer:utils \
  buck2:editor:publish:restate-effect \
  buck2:editor:publish:otel-contract \
  buck2:editor:publish:playwright
do
  printf '{"tasks":[{"name":"%s"}]}\n' "$forbidden_task" > "$fixture"
  if output="$(EFFECT_UTILS_CI_TEST=1 DEVENV_TASKS_JSON="$fixture" \
    DEVENV_TASK_GRAPH_DEPENDENCIES_ONLY=0 \
    "$NODE_BIN" "$ROOT/scripts/devenv-task-graph-check.mjs" "$ROOT" 2>&1)"
  then
    echo "FAIL: unit task graph accepted forbidden task $forbidden_task" >&2
    exit 1
  fi
  case "$output" in
    *"unit profile excludes deploy, browser, live integration and consumer aggregate tasks: $forbidden_task"*) ;;
    *)
      echo "FAIL: unit task graph rejected $forbidden_task for the wrong reason: $output" >&2
      exit 1
      ;;
  esac
done
