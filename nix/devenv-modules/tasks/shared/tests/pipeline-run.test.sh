#!/usr/bin/env bash
set -euo pipefail
span=${1:?pass otel-span executable}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

expect_vector() {
  local got
  got=$("$span" pipeline-derive "$1" "$2")
  [[ "$got" == "trace=$3 root=$4 job=$5" ]] || { printf 'identity mismatch: %s\n' "$got" >&2; exit 1; }
}
expect_vector local/38d198bc-4ba9-42b1-b11c-60f1a2a00db1 worker/local \
  4c5cf5acb050a9cd662e1fc7714f6eb3 ddafe71fe577aaee 94858ceb03926a01
expect_vector ci/forge/repo%2Fmodule/421/2 'build[os=linux]' \
  7a371c25e1cdd9310f41bf4e68258873 8575a743f3e704ce 375a82ccc85b7720
expect_vector ci/forge/repo%2Fmodule/421/3 'build[os=linux]' \
  9b8ca9aa66a0bfccee03149ae0dbd7e7 ea002faa119c8557 334dee18a70271e4

for bad in local/not-a-uuid ci/forge/repo/421 ci/forge/repo/421/0 \
  'ci/forge/repo%2fmodule/421/2' 'ci/forge/repo%41/421/2' \
  'ci/forge/repo%FF/421/2'; do
  if "$span" pipeline-derive "$bad" worker/local >/dev/null 2>&1; then
    printf 'accepted invalid run id: %s\n' "$bad" >&2; exit 1
  fi
done

# run and buck2 preparation accept the same W3C contexts. Unsampled flags
# survive in the child and in the Buck command sidecar.
for bad in \
  00-00000000000000000000000000000000-1111111111111111-01 \
  00-11111111111111111111111111111111-0000000000000000-01 \
  00-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-1111111111111111-01 \
  01-11111111111111111111111111111111-1111111111111111-01; do
  OTEL_SPAN_SPOOL_DIR="$tmp" TRACEPARENT="$bad" "$span" run test context -- bash -c 'printf "%s\n" "$TRACEPARENT"' > "$tmp/child"
  [[ $(< "$tmp/child") != "$bad" ]] || { printf 'run accepted invalid context: %s\n' "$bad" >&2; exit 1; }
  TRACEPARENT="$bad" "$span" buck2 --sidecar "$tmp/bad.sidecar" > "$tmp/prepare"
  [[ $(grep -c '^unset BUCK_COMMAND_TRACE_ID' "$tmp/prepare") == 1 ]] || exit 1
done
valid=00-11111111111111111111111111111111-2222222222222222-00
OTEL_SPAN_SPOOL_DIR="$tmp" TRACEPARENT="$valid" "$span" run test unsampled -- bash -c 'printf "%s\n" "$TRACEPARENT"' > "$tmp/child"
[[ $(cut -d- -f4 < "$tmp/child") == 00 ]]
TRACEPARENT="$valid" "$span" buck2 --sidecar "$tmp/good.sidecar" > "$tmp/prepare"
[[ $(sed 's/.*-//' "$tmp/good.sidecar") == 00 ]]

export DEVENV_ROOT="$tmp" OTEL_SPAN_BIN="$span"
"$span" pipeline-run -- bash -c '"$OTEL_SPAN_BIN" pipeline-run -- bash -c '\''printf "%s\n" "$TRACEPARENT"'\''' > "$tmp/nested"
trace=$(cut -d- -f2 < "$tmp/nested")
root="$tmp/.devenv/otel/run-records"
[[ $(find "$root" -name '*.jsonl' | wc -l) == 2 ]]
[[ $(find "$root" -name '*.jsonl' -exec cat {} + | jq -s --arg trace "$trace" '[.[].resourceSpans[].scopeSpans[].spans[] | select(.traceId == $trace and .name == "cicd.pipeline.run")] | length') == 1 ]]

# A CI-provided run is seeded but never emits the root locally, and an
# unrelated inherited task trace must not override either seed.
ci_id=ci/forge/repo%2Fmodule/421/2
ci_trace=7a371c25e1cdd9310f41bf4e68258873
PIPELINE_RUN_ID="$ci_id" PIPELINE_TASK_KEY='build[os=linux]' \
  OTEL_TASK_TRACEPARENT="$valid" TRACEPARENT="$valid" \
  DEVENV_ROOT="$tmp/ci" "$span" pipeline-run -- bash -c \
  '[[ "$TRACEPARENT" == "$OTEL_TASK_TRACEPARENT" ]] && printf "%s\n" "$TRACEPARENT"' > "$tmp/ci-child"
[[ $(cut -d- -f2 < "$tmp/ci-child") == "$ci_trace" ]]
[[ $(find "$tmp/ci/.devenv/otel/run-records" -name '*.jsonl' | wc -l) == 0 ]]

# Cancellation must write the one local root with a signal exit status.
mkfifo "$tmp/ready"
PIPELINE_TEST_READY="$tmp/ready" DEVENV_ROOT="$tmp/interrupted" \
  "$span" pipeline-run -- bash -c 'printf "ready\n" > "$PIPELINE_TEST_READY"; exec sleep 30' &
child=$!
read -r -t 5 marker < "$tmp/ready"
[[ "$marker" == ready ]]
kill -TERM "$child"
rc=0
wait "$child" || rc=$?
[[ "$rc" == 143 ]]
[[ $(find "$tmp/interrupted/.devenv/otel/run-records" -name '*.jsonl' -exec cat {} + | jq -s '[.[].resourceSpans[].scopeSpans[].spans[] | select(.name == "cicd.pipeline.run" and (.attributes | any(.key == "exit.code" and .value.intValue == "143")))] | length') == 1 ]]

# The new root replaces a caller trace and links back. Its participating
# otel-span owner writes a forward link before completing its own span.
outer_trace=11111111111111111111111111111111
outer_parent=2222222222222222
DEVENV_ROOT="$tmp/linked" OTEL_SPAN_SPOOL_DIR="$tmp" \
  TRACEPARENT="00-$outer_trace-$outer_parent-01" \
  "$span" run test outer -- "$span" pipeline-run -- bash -c ':'
[[ $(find "$tmp/linked/.devenv/otel/run-records" -name '*.jsonl' -exec cat {} + | jq -s --arg id "$outer_trace" '[.[].resourceSpans[].scopeSpans[].spans[] | select(.name == "cicd.pipeline.run" and .traceId != $id and (.links | any(.traceId == $id)))] | length') == 1 ]]
[[ $(jq -s '[.[].resourceSpans[].scopeSpans[].spans[] | select(.name == "outer" and (.links | length == 1))] | length' "$tmp/spans.jsonl") == 1 ]]
printf 'pipeline-run vectors, context parity, and nested root passed: %s\n' "$trace"
