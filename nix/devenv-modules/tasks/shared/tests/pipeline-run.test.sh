#!/usr/bin/env bash
set -euo pipefail
span=${1:-${OTEL_SPAN_BIN:?otel-span binary required}}
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
  PIPELINE_EXPORT_OWNER= OTELITE_HTTP_ENDPOINT= DEVENV_ROOT="$tmp" OTEL_EXPORTER_OTLP_ENDPOINT= \
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

# A fork must never use direct HTTP when local spool creation fails.
if PIPELINE_RUN_ID="$run" PIPELINE_JOB_KEY=test PIPELINE_MATRIX_RUNNER="$runner" \
  PIPELINE_FORK=true PIPELINE_TRUSTED=false DEVENV_ROOT=/proc \
  OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9 \
  "$span" pipeline-run -- bash -c '[[ -z ${OTEL_EXPORTER_OTLP_ENDPOINT:-} ]]'; then
  echo 'fork spool failure remained local'
else
  echo 'fork spool failure leaked the exporter endpoint' >&2
  exit 1
fi

# Once conversion succeeds, a failed delivery retries chunks, not native inputs.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/buck2-events" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
mode=$1
shift
for arg in "$@"; do
  if [[ ${previous:-} == --spool-dir ]]; then spool=$arg; fi
  previous=$arg
done
case "$mode" in
  ingest)
    echo ingest >> "$MOCK_CALLS"
    printf 'pending\n' > "$spool/mock.metrics.chunk"
    ;;
  export)
    [[ ${MOCK_EXPORT_FAIL:-} == 1 || "$spool" == */expired/pending || "$spool" == */oversized/pending ]] && exit 1
    rm -f "$spool/"*.chunk
    ;;
esac
MOCK
chmod +x "$tmp/bin/buck2-events"
export MOCK_CALLS="$tmp/calls"
printf 'buck log\n' > "$spool/buck2/input.pb.zst"
PATH="$tmp/bin:$PATH" MOCK_EXPORT_FAIL=1 DEVENV_ROOT="$tmp" \
  "$span" pipeline-export --spool "$spool" && { echo 'expected delivery failure' >&2; exit 1; }
[[ ! -f "$spool/buck2/input.pb.zst" && -f "$spool/pending/mock.metrics.chunk" ]]
PATH="$tmp/bin:$PATH" DEVENV_ROOT="$tmp" "$span" pipeline-export --spool "$spool"
[[ $(wc -l < "$MOCK_CALLS") == 1 && ! -d "$spool" ]] || {
  echo 'retry re-ingested Buck logs or failed to prune completed run' >&2
  exit 1
}

# Old undelivered chunks have bounded retention even without a live endpoint.
old="$tmp/.devenv/otel/run-records/expired"
mkdir -p "$old/pending"
printf 'pending\n' > "$old/pending/old.metrics.chunk"
touch -d '8 days ago' "$old"
mkdir -p "$spool/pending" "$spool/spans" "$spool/buck2"
PATH="$tmp/bin:$PATH" DEVENV_ROOT="$tmp" "$span" pipeline-export --spool "$spool"
[[ ! -d "$old" && ! -d "$spool" ]] || {
  echo 'old offline chunks or completed run were retained' >&2
  exit 1
}

# Cap bytes as well as age, counting apparent bytes rather than allocated blocks.
large="$tmp/.devenv/otel/run-records/oversized"
mkdir -p "$large/pending" "$spool/pending" "$spool/spans" "$spool/buck2"
truncate -s 536870913 "$large/pending/large.metrics.chunk"
PATH="$tmp/bin:$PATH" DEVENV_ROOT="$tmp" "$span" pipeline-export --spool "$spool"
[[ ! -d "$large" && ! -d "$spool" ]] || {
  echo 'oversized offline chunk was retained' >&2
  exit 1
}
