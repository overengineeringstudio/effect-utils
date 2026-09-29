#!/usr/bin/env bash
set -euo pipefail
span=${1:?otel-span binary required}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

run='ci/github/overengineeringstudio%2Feffect-utils/421/2'
runner='namespace-profile-linux-x86-64'
expected='trace=dc8939be377d7ae198ab958b5457787c root=53fa95f498248e99'
[[ $("$span" pipeline-derive "$run" test "runner=$runner") == "$expected" ]]
[[ $("$span" pipeline-derive "$run" test "runner=$runner") == "$expected" ]]
[[ $("$span" pipeline-derive "$run" typecheck) != "$expected" ]]
[[ $("$span" pipeline-derive "$run" test runner=a axis=b) == \
  $("$span" pipeline-derive "$run" test axis=b runner=a) ]]
if "$span" pipeline-derive "$run" test runner=a runner=b 2>/dev/null; then
  echo 'duplicate matrix dimension accepted' >&2
  exit 1
fi
if "$span" pipeline-derive 'ci/github/repo/421' test >/dev/null 2>&1; then
  echo 'invalid run ID accepted' >&2
  exit 1
fi

# No endpoint: a job root and task span must remain as pending OTLP chunks.
PIPELINE_RUN_ID="$run" PIPELINE_JOB_KEY=test PIPELINE_MATRIX_RUNNER="$runner" \
  DEVENV_ROOT="$tmp" OTEL_EXPORTER_OTLP_ENDPOINT= \
  "$span" pipeline-run -- bash -c '[[ $TRACEPARENT == 00-dc8939be377d7ae198ab958b5457787c-*-01 && $TRACEPARENT == "$OTEL_TASK_TRACEPARENT" ]]'
spool="$tmp/.devenv/otel/run-records/dc8939be377d7ae198ab958b5457787c-53fa95f498248e99"
[[ -d "$spool/pending" ]]
mapfile -t chunks < <(find "$spool/pending" -maxdepth 1 -name '*.traces.chunk' -type f)
[[ ${#chunks[@]} == 2 ]] || { echo "Expected two pending OTLP spans, got ${#chunks[@]}" >&2; exit 1; }
root_count=0
task_count=0
for chunk in "${chunks[@]}"; do
  body=$(jq -sR 'split("\n")[1] | fromjson' "$chunk")
  trace=$(jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId' <<< "$body")
  [[ "$trace" == dc8939be377d7ae198ab958b5457787c ]]
  name=$(jq -r '.resourceSpans[0].scopeSpans[0].spans[0].name' <<< "$body")
  case "$name" in
    cicd.pipeline.job)
      [[ $(jq -r '.resourceSpans[0].scopeSpans[0].spans[0].spanId' <<< "$body") == 53fa95f498248e99 ]]
      [[ $(jq -r '.resourceSpans[0].scopeSpans[0].spans[0].attributes[] | select(.key=="cicd.pipeline.run.id").value.stringValue' <<< "$body") == "$run" ]]
      ((root_count += 1)) ;;
    cicd.pipeline.task.run) ((task_count += 1)) ;;
    *) echo "Unexpected span: $name" >&2; exit 1 ;;
  esac
done
[[ $root_count == 1 && $task_count == 1 ]]
printf 'canonical job identity and offline OTLP spool passed: %s\n' "$spool"
