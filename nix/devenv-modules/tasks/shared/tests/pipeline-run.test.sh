#!/usr/bin/env bash
set -euo pipefail
span=${1:-${OTEL_SPAN_BIN:?otel-span binary required}}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# CI wraps the test task in a pipeline-run; this probe owns a separate local spool.
unset PIPELINE_ENTRYPOINT_ACTIVE PIPELINE_SPOOL_DIR

run='ci/github/overengineeringstudio%2Feffect-utils/421/2'
runner='namespace-profile-linux-x86-64'
expected='trace=dc8939be377d7ae198ab958b5457787c root=53fa95f498248e99'
[[ $("$span" pipeline-derive "$run" test "runner=$runner") == "$expected" ]]
[[ $("$span" pipeline-derive "$run" test "runner=$runner") == "$expected" ]]
[[ $("$span" pipeline-derive "$run" typecheck) != "$expected" ]]
[[ $("$span" pipeline-derive "$run" test runner=a axis=b) == \
  $("$span" pipeline-derive "$run" test axis=b runner=a) ]]

# Native Darwin locale restoration used to crash the digest writer after fork.
# Check exact identities repeatedly with the devenv environment and UTF-8 locale.
for ((probe = 0; probe < 200; probe++)); do
  derived=$(env name=devenv-shell-env LC_ALL=en_US.UTF-8 "$span" pipeline-derive "$run" typecheck)
  [[ $derived == 'trace=c829481d1ffcf4bb2968d5fc5b7cb5b4 root=918303269d68c6c9' ]] ||
    { echo "unstable canonical identity at iteration $probe: $derived" >&2; exit 1; }
done
printf '200 exact pipeline identities passed with the devenv environment and UTF-8 locale\n'
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
  PIPELINE_EXPORT_OWNER= OTELITE_HTTP_ENDPOINT= DEVENV_ROOT="$tmp" OTEL_EXPORTER_OTLP_ENDPOINT= LC_ALL=en_US.UTF-8 \
  "$span" pipeline-run -- bash -c '[[ $TRACEPARENT == 00-dc8939be377d7ae198ab958b5457787c-*-01 && $TRACEPARENT == "$OTEL_TASK_TRACEPARENT" && $LC_ALL == en_US.UTF-8 ]]'
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

# GitHub's adapter owns the root across two independent task steps; the last
# successful task must not mask the earlier failure in the job-level status.
repo=${2:-$(realpath "$(dirname "$0")/../../../../..")}
mkdir -p "$tmp/bin"
ln -s "$(realpath "$span")" "$tmp/bin/otel-span"
cat > "$tmp/bin/devenv" <<'SH'
#!/usr/bin/env bash
[[ $1 == shell && $2 == -- ]] || exit 1
shift 2
exec "$@"
SH
cat > "$tmp/bin/buck2-events" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$tmp/bin/devenv" "$tmp/bin/buck2-events"
git -C "$tmp" init -q
git -C "$tmp" -c core.hooksPath=/dev/null -c user.name=CI -c user.email=ci@example.invalid commit -q --allow-empty -m initial
env GITHUB_WORKSPACE="$tmp" GITHUB_ENV="$tmp/job.env" \
  GITHUB_REPOSITORY=overengineeringstudio/effect-utils GITHUB_RUN_ID=421 \
  GITHUB_RUN_ATTEMPT=2 GITHUB_EVENT_NAME=pull_request JOB_KEY=typecheck \
  bash "$repo/genie/ci-scripts/evidence-job.sh" identity
read -r start_line < "$tmp/job.env"
[[ ${start_line#*=} =~ ^[0-9]+$ ]]
cat > "$tmp/bin/python3" <<'SH'
#!/usr/bin/env bash
echo 'not-a-timestamp'
SH
chmod +x "$tmp/bin/python3"
env PATH="$tmp/bin:$PATH" GITHUB_WORKSPACE="$tmp" GITHUB_ENV="$tmp/fallback.env" \
  GITHUB_REPOSITORY=overengineeringstudio/effect-utils GITHUB_RUN_ID=421 \
  GITHUB_RUN_ATTEMPT=2 GITHUB_EVENT_NAME=pull_request JOB_KEY=typecheck \
  bash "$repo/genie/ci-scripts/evidence-job.sh" identity
read -r fallback_line < "$tmp/fallback.env"
fallback_ns=${fallback_line#*=}
[[ $fallback_ns =~ ^[0-9]+000000000$ ]] || { echo "Invalid fallback timestamp: $fallback_ns" >&2; exit 1; }
rm "$tmp/bin/python3"
set -a
source "$tmp/job.env"
set +a
[[ $PIPELINE_RUN_ID == "$run" && $PIPELINE_EXPORT_OWNER == adapter ]]
job=typecheck
read -r trace_assignment root_assignment <<< "$("$span" pipeline-derive "$run" "$job")"
job_trace=${trace_assignment#trace=}
job_root=${root_assignment#root=}
job_spool="$tmp/.devenv/otel/run-records/$job_trace-$job_root"
job_env=(PIPELINE_RUN_ID="$PIPELINE_RUN_ID" PIPELINE_JOB_KEY="$PIPELINE_JOB_KEY"
  PIPELINE_EXPORT_OWNER="$PIPELINE_EXPORT_OWNER" OTELITE_HTTP_ENDPOINT=
  OTEL_EXPORTER_OTLP_ENDPOINT= DEVENV_ROOT="$tmp")
code=0
env "${job_env[@]}" "$span" pipeline-run -- bash -c 'exit 13' || code=$?
[[ $code == 13 ]] || { echo "task failure was replaced: $code" >&2; exit 1; }
env "${job_env[@]}" "$span" pipeline-run -- bash -c 'exit 0'
mapfile -t before < <(find "$job_spool/spans" -maxdepth 1 -name '*.jsonl' -type f)
[[ ${#before[@]} == 2 ]] || { echo "CI steps emitted a root instead of two task spans" >&2; exit 1; }
env PATH="$tmp/bin:$PATH" DEVENV_BIN="$tmp/bin/devenv" GITHUB_WORKSPACE="$tmp" \
  PIPELINE_JOB_START_NS="$PIPELINE_JOB_START_NS" \
  "${job_env[@]}" bash "$repo/genie/ci-scripts/evidence-job.sh" export failure
mapfile -t chunks < <(find "$job_spool/pending" -maxdepth 1 -name '*.traces.chunk' -type f)
[[ ${#chunks[@]} == 3 ]] || { echo "Expected one job root and two tasks, got ${#chunks[@]}" >&2; exit 1; }
root_count=0
task_count=0
declare -A task_ids=()
root_end=0
latest_task_end=0
task_statuses=0
for chunk in "${chunks[@]}"; do
  body=$(jq -sR 'split("\n")[1] | fromjson | .resourceSpans[0].scopeSpans[0].spans[0]' "$chunk")
  [[ $(jq -r '.traceId' <<< "$body") == "$job_trace" ]]
  name=$(jq -r '.name' <<< "$body")
  case "$name" in
    cicd.pipeline.job)
      [[ $(jq -r '.spanId' <<< "$body") == "$job_root" ]]
      [[ $(jq -r '.startTimeUnixNano' <<< "$body") == "$PIPELINE_JOB_START_NS" ]]
      [[ $(jq -r '.status.code' <<< "$body") == 2 ]]
      [[ $(jq -r '.attributes[] | select(.key=="cicd.pipeline.task.run.result").value.stringValue' <<< "$body") == failure ]]
      [[ $(jq -r '.attributes[] | select(.key=="vcs.provider.name").value.stringValue' <<< "$body") == github ]]
      [[ $(jq -r '.attributes[] | select(.key=="buck2.vcs.change.is_fork").value.boolValue' <<< "$body") == false ]]
      root_end=$(jq -r '.endTimeUnixNano' <<< "$body")
      ((root_count += 1)) ;;
    cicd.pipeline.task.run)
      [[ $(jq -r '.parentSpanId' <<< "$body") == "$job_root" ]]
      task_ids[$(jq -r '.spanId' <<< "$body")]=1
      task_end=$(jq -r '.endTimeUnixNano' <<< "$body")
      (( task_end > latest_task_end )) && latest_task_end=$task_end
      (( task_statuses += $(jq -r '.status.code' <<< "$body") ))
      ((task_count += 1)) ;;
    *) echo "Unexpected span: $name" >&2; exit 1 ;;
  esac
done
[[ $root_count == 1 && $task_count == 2 && ${#task_ids[@]} == 2 && $task_statuses == 3 ]]
[[ $root_end -ge $latest_task_end ]]

# Provider conclusions are normalized once, with no vendor status alias.
for mapping in success:success failure:failure cancelled:cancellation skipped:skip timed_out:timeout startup_failure:error; do
  conclusion=${mapping%%:*}
  result=${mapping#*:}
  rm -rf "$job_spool"
  env PATH="$tmp/bin:$PATH" DEVENV_BIN="$tmp/bin/devenv" GITHUB_WORKSPACE="$tmp" \
    PIPELINE_JOB_START_NS="$PIPELINE_JOB_START_NS" \
    "${job_env[@]}" bash "$repo/genie/ci-scripts/evidence-job.sh" export "$conclusion"
  mapfile -t chunks < <(find "$job_spool/pending" -maxdepth 1 -name '*.traces.chunk' -type f)
  body=$(jq -sR 'split("\n")[1] | fromjson | .resourceSpans[0].scopeSpans[0].spans[0]' "${chunks[0]}")
  [[ $(jq -r '.attributes[] | select(.key=="cicd.pipeline.task.run.result").value.stringValue' <<< "$body") == "$result" ]]
done

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

# A cleanup error cannot replace the wrapped task's exit status.
if [[ $(id -u) != 0 ]]; then
  mkdir -p "$spool/pending" "$spool/spans" "$spool/buck2"
  chmod 500 "$(dirname "$spool")"
  code=0
  PIPELINE_RUN_ID="$run" PIPELINE_JOB_KEY=test PIPELINE_MATRIX_RUNNER="$runner" \
    PIPELINE_EXPORT_OWNER= DEVENV_ROOT="$tmp" OTEL_EXPORTER_OTLP_ENDPOINT= \
    "$span" pipeline-run -- bash -c 'exit 17' || code=$?
  chmod 700 "$(dirname "$spool")"
  [[ $code == 17 ]] || { echo "cleanup replaced task exit status: $code" >&2; exit 1; }
fi
