#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${DEVENV_ROOT:-$(cd "$TESTS_DIR/../../../../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

# Validate the active profile: unit CI keeps the guard enabled, with narrowed
# expectations selected by the same job-level flag as devenv.nix.
"$NODE_BIN" "$ROOT/scripts/devenv-task-graph-check.mjs" "$ROOT"

fixture="$(mktemp)"
fixture_root="$(mktemp -d)"
trap 'rm -f "$fixture"; rm -rf "$fixture_root"' EXIT
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

# Reproduce 68d9bc4c: the unit graph omits Notion tasks, but its selected
# script calls those tasks through a literal shell array.
mkdir -p "$fixture_root/genie/ci-workflow" \
  "$fixture_root/nix/devenv-modules/tasks/shared/tests"
cp "$ROOT/nix/devenv-modules/tasks/shared/tests/notion-integration-ci.test.sh" \
  "$fixture_root/nix/devenv-modules/tasks/shared/tests/"
printf '{"tasks":[{"name":"devenv-modules:test"}]}\n' > "$fixture"
printf '{"moduleScripts":{"darwin":[],"neutral":[{"script":"notion-integration-ci.test.sh"}]}}\n' \
  > "$fixture_root/genie/ci-workflow/test-platforms.json"
script_calls_guard() {
  EFFECT_UTILS_CI_TEST=1 EFFECT_UTILS_TEST_PLATFORM=linux \
    DEVENV_TASKS_JSON="$fixture" DEVENV_TASK_GRAPH_SCRIPT_CALLS_ONLY=1 \
    DEVENV_TASK_GRAPH_DEPENDENCIES_ONLY=0 \
    "$NODE_BIN" "$ROOT/scripts/devenv-task-graph-check.mjs" "$fixture_root"
}
if output="$(script_calls_guard 2>&1)"; then
  echo "FAIL: unit graph accepted the original Notion nested-task regression" >&2
  exit 1
fi
case "$output" in
  *"unit-selected module scripts call only tasks in the unit profile: notion-integration-ci.test.sh -> test:notion-integration:notion-effect-client"*) ;;
  *) echo "FAIL: nested-task regression failed for the wrong reason: $output" >&2; exit 1 ;;
esac
printf 'PASS: original unit-selected Notion script is rejected before execution\n'

# Literal and array-based calls to present tasks pass the same scanner.
printf '{"tasks":[{"name":"devenv-modules:test"},{"name":"kept:task"}]}\n' > "$fixture"
printf 'tasks=(\n  kept:task\n)\ndevenv tasks run --mode single "${tasks[@]}" kept:task\n' \
  > "$fixture_root/nix/devenv-modules/tasks/shared/tests/notion-integration-ci.test.sh"
script_calls_guard

# The fix keeps the script in the full profile without pulling its tasks back
# into the unit closure.
printf '{"tasks":[{"name":"devenv-modules:test"}]}\n' > "$fixture"
printf '{"moduleScripts":{"darwin":[],"neutral":[{"script":"notion-integration-ci.test.sh","fullProfileOnly":true}]}}\n' \
  > "$fixture_root/genie/ci-workflow/test-platforms.json"
script_calls_guard
printf 'PASS: full-profile-only Notion script is excluded from unit graph calls\n'
