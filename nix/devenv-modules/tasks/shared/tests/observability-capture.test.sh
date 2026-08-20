#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${DEVENV_ROOT:-$(cd "$TESTS_DIR/../../../../.." && pwd)}"

capture_source="$ROOT/nix/devenv-modules/observability.nix"
trace_source="$ROOT/nix/devenv-modules/tasks/lib/trace.nix"

awk 'index($0, "devenv --verbose tasks run \"$1\" \\") { found = 1 } END { exit !found }' "$capture_source" || {
  echo "FAIL: observability capture must enable verbose Devenv task activities" >&2
  exit 1
}

awk 'index($0, "export OTEL_TASK_STDERR_FD=3") { found = 1 } END { exit !found }' "$capture_source" \
  && awk 'index($0, "exec 2>&\"$OTEL_TASK_STDERR_FD\"") { found = 1 } END { exit !found }' "$trace_source" || {
  echo "FAIL: observability capture must preserve successful task stderr" >&2
  exit 1
}

lineage_filter='([.[] | select(.service == "effect-utils-devenv" and .name == "devenv.task.exec")][0]) as $effect
  | $effect != null
    and any(.[];
      .service == "devenv"
      and .name == "setup:gate"
      and .span_id == $effect.parent_span_id
      and .trace_id == $effect.trace_id
    )
    and any(.[];
      .service == "devenv"
      and .name == "execute command"
      and .parent_span_id == $effect.parent_span_id
      and .trace_id == $effect.trace_id
    )'

valid_lineage='[
  {"service":"devenv","name":"setup:gate","trace_id":"other-trace","span_id":"other-task","parent_span_id":"other-root"},
  {"service":"devenv","name":"setup:gate","trace_id":"trace","span_id":"task","parent_span_id":"root"},
  {"service":"devenv","name":"execute command","trace_id":"trace","span_id":"execute","parent_span_id":"task"},
  {"service":"effect-utils-devenv","name":"devenv.task.exec","trace_id":"trace","span_id":"bridge","parent_span_id":"task"}
]'

printf '%s\n' "$valid_lineage" | jq -e "$lineage_filter" >/dev/null || {
  echo "FAIL: observability capture must admit a bridge parented by a native task with an execute child" >&2
  exit 1
}

unrelated_execute='[
  {"service":"devenv","name":"setup:gate","trace_id":"trace","span_id":"task","parent_span_id":"root"},
  {"service":"devenv","name":"execute command","trace_id":"trace","span_id":"execute","parent_span_id":"other-task"},
  {"service":"effect-utils-devenv","name":"devenv.task.exec","trace_id":"trace","span_id":"bridge","parent_span_id":"task"}
]'

if printf '%s\n' "$unrelated_execute" | jq -e "$lineage_filter" >/dev/null; then
  echo "FAIL: observability capture must reject an unrelated execute command span" >&2
  exit 1
fi

unrelated_bridge='[
  {"service":"devenv","name":"setup:gate","trace_id":"trace","span_id":"task","parent_span_id":"root"},
  {"service":"devenv","name":"execute command","trace_id":"trace","span_id":"execute","parent_span_id":"task"},
  {"service":"effect-utils-devenv","name":"devenv.task.exec","trace_id":"trace","span_id":"bridge","parent_span_id":"other-task"}
]'

if printf '%s\n' "$unrelated_bridge" | jq -e "$lineage_filter" >/dev/null; then
  echo "FAIL: observability capture must reject a bridge outside the native task lineage" >&2
  exit 1
fi

echo "observability capture test passed"
