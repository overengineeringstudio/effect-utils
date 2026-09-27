#!/usr/bin/env bash
set -euo pipefail
span=${1:-$(command -v otel-span)}
python=${2:-python3}
# Runs inside a seeded task: start from no ambient trace or run identity.
unset TRACEPARENT OTEL_TASK_TRACEPARENT OTEL_SPAN_SPOOL_DIR OTEL_SPOOL_MULTI_WRITER \
  OTEL_EXPORTER_OTLP_ENDPOINT OTELITE_HTTP_ENDPOINT OTEL_SPAN_FORWARD_LINK_FILE \
  PIPELINE_RUN_ID PIPELINE_TASK_KEY PIPELINE_ROOT_OWNER PIPELINE_ENTRYPOINT_ACTIVE \
  PIPELINE_SEAL_OWNER PIPELINE_SPOOL_DIR PIPELINE_TRACE_ID PIPELINE_ROOT_SPAN_ID \
  PIPELINE_TASK_SPAN_ID BUCK2_EVIDENCE_UPLOAD_URL
tmp=$(mktemp -d)
http_pid=
cleanup() {
  if [[ -n "$http_pid" ]]; then
    kill "$http_pid" 2>/dev/null || true
    wait "$http_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
mkdir -p "$tmp/bin"
cat > "$tmp/bin/buck2-evidence" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$PIPELINE_TEST_SEALS"
if [[ ${PIPELINE_TEST_AMBIGUOUS:-} == 1 && $1 == upload && ${2:-} != --pending ]]; then
  while (($#)); do
    if [[ $1 == --spool ]]; then
      mkdir -p "$2"
      printf 'pending\n' > "$2/upload-pending"
      exit 1
    fi
    shift
  done
fi
SH
chmod +x "$tmp/bin/buck2-evidence"
export PATH="$tmp/bin:$PATH" PIPELINE_TEST_SEALS="$tmp/seals"

# Without an evidence consumer, an OTLP endpoint retains direct HTTP delivery.
# The seed is still available to the child, but must not redirect to disk.
PATH=/usr/bin:/bin OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1 \
  DEVENV_ROOT="$tmp/no-evidence" "$span" pipeline-run -- "$BASH" -c \
  '[[ -z ${OTEL_SPAN_SPOOL_DIR:-} && -z ${PIPELINE_SPOOL_DIR:-} && -n ${TRACEPARENT:-} ]]'
[[ ! -e "$tmp/no-evidence/.devenv/otel/run-records" ]]
# OTelite-only shells set OTELITE_HTTP_ENDPOINT rather than the generic
# exporter variable. A real HTTP receiver proves both local root and job
# spans arrive even without buck2-evidence to drain a spool.
mkfifo "$tmp/http-ready"
"$python" -u - "$tmp/http-ready" "$tmp/http-spans.jsonl" <<'PY' &
import http.server
import sys

ready, output = sys.argv[1:]

class Receiver(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/v1/traces":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers["Content-Length"]))
        with open(output, "ab") as spans:
            spans.write(body + b"\n")
        self.send_response(200)
        self.end_headers()

    def log_message(self, *_):
        pass

server = http.server.HTTPServer(("127.0.0.1", 0), Receiver)
with open(ready, "w") as pipe:
    pipe.write(str(server.server_port) + "\n")
server.serve_forever()
PY
http_pid=$!
read -r -t 5 http_port < "$tmp/http-ready"
PATH=/usr/bin:/bin OTELITE_HTTP_ENDPOINT="http://127.0.0.1:$http_port" \
  DEVENV_ROOT="$tmp/otelite-only" "$span" pipeline-run -- "$BASH" -c \
  '[[ $OTEL_EXPORTER_OTLP_ENDPOINT == "$OTELITE_HTTP_ENDPOINT" ]]'
[[ $(jq -s '[.[].resourceSpans[].scopeSpans[].spans[] | select(.name == "cicd.pipeline.run" or .name == "cicd.pipeline.task.run")] | length' "$tmp/http-spans.jsonl") == 2 ]]
[[ ! -e "$tmp/otelite-only/.devenv/otel/run-records" ]]
kill "$http_pid"
wait "$http_pid" 2>/dev/null || true
http_pid=

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
expect_vector ci/forge/repo%2Fmodule/421/2 'compile[locale=ö]' \
  7a371c25e1cdd9310f41bf4e68258873 8575a743f3e704ce f0f360ed828c9728

for bad in local/not-a-uuid ci/forge/repo/421 ci/forge/repo/421/0 \
  'ci/forge/repo%2fmodule/421/2' 'ci/forge/repo%41/421/2' \
  'ci/forge/repo%FF/421/2'; do
  if "$span" pipeline-derive "$bad" worker/local >/dev/null 2>&1; then
    printf 'accepted invalid run id: %s\n' "$bad" >&2; exit 1
  fi
done

# An externally owned CI run cannot silently collapse multiple jobs into
# worker/local when its matrix-qualified key is missing.
PIPELINE_RUN_ID=ci/forge/repo%2Fmodule/421/2 \
  OTEL_TASK_TRACEPARENT=00-11111111111111111111111111111111-2222222222222222-01 \
  env -u PIPELINE_TASK_KEY "$span" pipeline-run -- bash -c \
    '[[ -z ${OTEL_TASK_TRACEPARENT:-} && -z ${PIPELINE_TRACE_ID:-} ]]' \
  2> "$tmp/missing-key"
[[ $(< "$tmp/missing-key") == *'invalid pipeline identity'* ]]

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
[[ $(grep -c '^seal$' "$PIPELINE_TEST_SEALS") == 1 ]]
# An inner caller may replace its own W3C context. It still cannot seal the
# active entrypoint's spool before the outer command is finished.
unset PIPELINE_TEST_SEALS
export PIPELINE_TEST_SEALS="$tmp/foreign-seals"
"$span" pipeline-run -- bash -c \
  'TRACEPARENT=00-11111111111111111111111111111111-2222222222222222-01 \
    OTEL_TASK_TRACEPARENT=00-11111111111111111111111111111111-2222222222222222-01 \
    "$OTEL_SPAN_BIN" pipeline-run -- bash -c \
      '\''[[ "$TRACEPARENT" == 00-"$PIPELINE_TRACE_ID"-* ]]'\'''
[[ $(grep -c '^seal$' "$PIPELINE_TEST_SEALS") == 1 ]]

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

# The adapter owns one spool across retries. Both attempts contribute evidence,
# and only the post-step may seal it after the final attempt.
export PIPELINE_TEST_SEALS="$tmp/adapter-seals"
for attempt in 1 2; do
  PIPELINE_RUN_ID="$ci_id" PIPELINE_TASK_KEY='build[os=linux]' \
    PIPELINE_SEAL_OWNER=adapter BUCK2_EVIDENCE_UPLOAD_URL=https://example.invalid/ \
    DEVENV_ROOT="$tmp/ci-adapter" \
    "$span" pipeline-run -- bash -c \
      'printf "%s\n" "$1" > "$OTEL_SPAN_SPOOL_DIR/attempt-$1.jsonl"' _ "$attempt"
done
adapter_spool="$tmp/ci-adapter/.devenv/otel/run-records/$ci_trace-375a82ccc85b7720"
[[ $(< "$adapter_spool/spans/attempt-1.jsonl") == 1 ]]
[[ $(< "$adapter_spool/spans/attempt-2.jsonl") == 2 ]]
[[ ! -e "$PIPELINE_TEST_SEALS" ]]
PIPELINE_SPOOL_DIR="$adapter_spool" buck2-evidence seal --spool "$adapter_spool" \
  --run-id "$ci_id" --task-key 'build[os=linux]'
[[ $(grep -c '^seal$' "$PIPELINE_TEST_SEALS") == 1 ]]

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

# A signal handler that completes cleanup with its own code must determine
# both the entrypoint exit and the root's recorded exit.code.
mkfifo "$tmp/handled-ready"
PIPELINE_TEST_READY="$tmp/handled-ready" DEVENV_ROOT="$tmp/handled" \
  "$span" pipeline-run -- bash -c \
    'trap "exit 7" TERM; printf "ready\n" > "$PIPELINE_TEST_READY"; while :; do sleep 1; done' &
child=$!
read -r -t 5 marker < "$tmp/handled-ready"
[[ "$marker" == ready ]]
kill -TERM "$child"
rc=0
wait "$child" || rc=$?
[[ "$rc" == 7 ]]
[[ $(find "$tmp/handled/.devenv/otel/run-records" -name '*.jsonl' -exec cat {} + | jq -s '[.[].resourceSpans[].scopeSpans[].spans[] | select(.name == "cicd.pipeline.run" and (.attributes | any(.key == "exit.code" and .value.intValue == "7")))] | length') == 1 ]]

# The new root replaces a caller trace and links back. Its participating
# otel-span owner writes a forward link before completing its own span.
outer_trace=11111111111111111111111111111111
outer_parent=2222222222222222
DEVENV_ROOT="$tmp/linked" OTEL_SPAN_SPOOL_DIR="$tmp" \
  TRACEPARENT="00-$outer_trace-$outer_parent-01" \
  "$span" run test outer -- "$span" pipeline-run -- bash -c ':'
[[ $(find "$tmp/linked/.devenv/otel/run-records" -name '*.jsonl' -exec cat {} + | jq -s --arg id "$outer_trace" '[.[].resourceSpans[].scopeSpans[].spans[] | select(.name == "cicd.pipeline.run" and .traceId != $id and (.links | any(.traceId == $id)))] | length') == 1 ]]
[[ $(jq -s '[.[].resourceSpans[].scopeSpans[].spans[] | select(.name == "outer" and (.links | length == 1))] | length' "$tmp/spans.jsonl") == 1 ]]
# A lost upload acknowledgement must not launch a competing local ingester.
# The real transport marks pending before sending; this fake models its failed exit.
: > "$tmp/ambiguous-seals"
rc=0
PIPELINE_TEST_AMBIGUOUS=1 PIPELINE_TEST_SEALS="$tmp/ambiguous-seals" \
  BUCK2_EVIDENCE_UPLOAD_URL=unix:///tmp/unreachable-evidence.sock \
  OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1 \
  DEVENV_ROOT="$tmp/ambiguous" "$span" pipeline-run -- bash -c 'exit 7' || rc=$?
[[ $rc == 7 ]]
[[ $(grep -c '^upload$' "$tmp/ambiguous-seals") == 2 ]]
[[ $(grep -c '^ingest$' "$tmp/ambiguous-seals" || true) == 0 ]]
[[ $(find "$tmp/ambiguous/.devenv/otel/run-records" -name upload-pending | wc -l) == 1 ]]

printf 'pipeline-run vectors, context parity, and nested root passed: %s\n' "$trace"
