#!/usr/bin/env bash
set -euo pipefail

source_root="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE not set}"
cd "$source_root"
bun scripts/buck2-cache-posture.ts "$source_root"
grep -Fq 'allow_cache_uploads = true' .buckconfig.local || { echo '::error::publisher cache posture was not selected'; exit 1; }
buck="${BUCK2_BIN:?BUCK2_BIN not set}"
# `log show` emits numeric protobuf enums in the pinned Buck2 release:
# https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_data/data.proto
readonly ACTION_EXECUTION_KIND_LOCAL=1
readonly ACTION_EXECUTION_KIND_ACTION_CACHE=3
readonly UPLOAD_RESULT_UPLOADED=1
# LOCAL, REMOTE, LOCAL_DEP_FILE, LOCAL_WORKER, LOCAL_ACTION_CACHE, REMOTE_WORKER.
readonly EXECUTED_OR_LOCAL_CACHE_KINDS='[1,2,7,8,10,11]'
context_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof-context-b"
target='effect_utils//packages/@overeng/ci-tools:ci-tools-candidate'
test_target='effect_utils//packages/@overeng/content-address:test'
proof_source="$source_root/packages/@overeng/ci-tools/bin/ci-tools.ts"
test_proof_source="$source_root/packages/@overeng/content-address/src/mod.unit.test.ts"
printf '%s\n' '' "// trusted remote-cache proof ${GITHUB_RUN_ID:?GITHUB_RUN_ID not set}-${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT not set}" >> "$proof_source"
printf '%s\n' '' "// trusted test-cache proof ${GITHUB_RUN_ID:?GITHUB_RUN_ID not set}-${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT not set}" >> "$test_proof_source"
evidence_a="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof-a.jsonl"
test_evidence_a="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-a.jsonl"
evidence_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof-b.jsonl"
test_evidence_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-b.jsonl"
test_evidence_c="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-c.jsonl"
test_red_evidence="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-red.jsonl"
test_source_backup="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-source.ts"
descriptor_a="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-product-descriptor-a.json"
descriptor_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-product-descriptor-b.json"
trap 'if [ -f "$test_source_backup" ]; then cp "$test_source_backup" "$test_proof_source"; fi; rm -f "$evidence_a" "$test_evidence_a" "$evidence_b" "$test_evidence_b" "$test_evidence_c" "$test_red_evidence" "$test_source_backup" "$descriptor_a" "$descriptor_b"; if [ -d "$context_b" ]; then (cd "$context_b" && "$buck" kill); fi; rm -rf "$context_b"' EXIT

# Preserve action keys/outcomes before each proof context's native logs are removed.
# Local invocations without a CI artifact declaration retain the existing proof flow.
capture_cache_evidence() {
  if [ -n "${CI_BUCK2_CACHE_EVIDENCE_PATH:-}" ]; then
    if ! bun "$source_root/genie/ci-scripts/buck2-cache-evidence.ts" \
      --events "$1" --output "$CI_BUCK2_CACHE_EVIDENCE_PATH" --context "$2"; then
      echo "::warning::Buck2 cache evidence capture failed for $2" >&2
    fi
  fi
}

# A failed Buck command still has diagnostic native evidence. Capture it before
# returning its original status, so EXIT cleanup cannot erase a failed replay.
run_proof_command() {
  local evidence="$1" context="$2" status=0
  shift 2
  "$buck" "$@" || status=$?
  if "$buck" log show --recent 0 > "$evidence"; then
    capture_cache_evidence "$evidence" "$context"
  else
    echo "::warning::Buck2 native event log unavailable for $context" >&2
    if [ "$status" -eq 0 ]; then return 1; fi
  fi
  return "$status"
}

# Context A executes locally and uploads run-unique source inputs.
# `log show --recent` uses zero-based history; 0 is the command just run.
"$buck" kill
rm -rf buck-out
run_proof_command "$evidence_a" proof-a-build build --local-only "$target"
if ! jq -e --argjson local "$ACTION_EXECUTION_KIND_LOCAL" --argjson uploaded "$UPLOAD_RESULT_UPLOADED" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.execution_kind == $local and $action.cache_upload_result == $uploaded)' "$evidence_a" >/dev/null; then
  echo '::error::Context A did not report a successful upload for a locally executed action'
  exit 1
fi
if ! jq -e --argjson local "$ACTION_EXECUTION_KIND_LOCAL" --argjson uploaded "$UPLOAD_RESULT_UPLOADED" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.name.category == "javascript_product_descriptor" and $action.execution_kind == $local and $action.cache_upload_result == $uploaded)' "$evidence_a" >/dev/null; then
  echo '::error::Context A did not execute and upload the product descriptor action'
  exit 1
fi
descriptor_path="$("$buck" build --local-only --show-full-json-output "${target}[descriptor]" | jq -r 'to_entries[0].value')"
cp "$descriptor_path" "$descriptor_a"
run_proof_command "$test_evidence_a" proof-a-test test --target-platforms effect_utils//buck2/platforms:host_platform --local-only "$test_target"
if ! jq -e --argjson local "$ACTION_EXECUTION_KIND_LOCAL" --argjson uploaded "$UPLOAD_RESULT_UPLOADED" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.name.category == "unit_test_verdict" and $action.execution_kind == $local and $action.cache_upload_result == $uploaded)' "$test_evidence_a" >/dev/null; then
  echo '::error::Context A did not execute and upload the representative unit-test verdict action'
  exit 1
fi

# Red verdicts fail the build action and are never uploaded, including when the
# same suite is requested again in the same daemon.
cp "$test_proof_source" "$test_source_backup"
printf '%s\n' 'it("remote-cache proof red verdict", () => { expect(true).toBe(false) })' >> "$test_proof_source"
for attempt in 1 2; do
  if run_proof_command "$test_red_evidence" "proof-red-$attempt" test --target-platforms effect_utils//buck2/platforms:host_platform --local-only "$test_target"; then
    echo '::error::A red verdict was accepted as a successful gate'
    exit 1
  fi
  if ! jq -e --argjson local "$ACTION_EXECUTION_KIND_LOCAL" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.name.category == "unit_test_verdict" and $action.execution_kind == $local and $action.failed == true)' "$test_red_evidence" >/dev/null; then
    echo "::error::Red verdict attempt $attempt did not rerun the unit suite locally"
    exit 1
  fi
  if jq -e --argjson uploaded "$UPLOAD_RESULT_UPLOADED" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.name.category == "unit_test_verdict" and $action.cache_upload_result == $uploaded)' "$test_red_evidence" >/dev/null; then
    echo '::error::A failed unit-test verdict action was uploaded'
    exit 1
  fi
done
cp "$test_source_backup" "$test_proof_source"
rm "$test_source_backup"

# Context B has a fresh daemon and materializer, no publisher overlay or credential.
"$buck" kill
unset BUCK2_CACHE_WRITE_BASIC_AUTH
rm -rf buck-out "$context_b"
mkdir -p "$context_b"
tar -C "$source_root" \
  --exclude='./.buckconfig.local' \
  --exclude='./.devenv' \
  --exclude='./.git' \
  --exclude='./buck-out' \
  --exclude='./node_modules' \
  --exclude='./packages/.editor-view' \
  --exclude='./target' \
  --exclude='./tmp' \
  --exclude='*/__pycache__' \
  --exclude='*/dist' \
  --exclude='*/node_modules' \
  --exclude='*/target' \
  -cf - . | tar -C "$context_b" -xf -
cd "$context_b"
export BUCK2_PUBLIC_CACHE_READ_ONLY=1
bun scripts/buck2-cache-posture.ts "$context_b"
grep -Fq 'remote_cache_enabled = true' .buckconfig.local || { echo '::error::reader cache posture was not selected'; exit 1; }
grep -Fq 'allow_cache_uploads = false' .buckconfig.local || { echo '::error::reader cache uploads were not disabled'; exit 1; }
if grep -Fq 'http_headers' .buckconfig.local; then echo '::error::reader cache inherited publisher auth'; exit 1; fi

# The independent build must hit the remote action cache, not run an action.
run_proof_command "$evidence_b" proof-b-build build --local-only "$target"
if ! jq -e --argjson action_cache "$ACTION_EXECUTION_KIND_ACTION_CACHE" 'select(.Event.data.SpanEnd.data.ActionExecution.execution_kind == $action_cache)' "$evidence_b" >/dev/null; then
  echo '::error::Context B did not report a remote action-cache hit'
  exit 1
fi
if jq -e --argjson kinds "$EXECUTED_OR_LOCAL_CACHE_KINDS" 'select(.Event.data.SpanEnd.data.ActionExecution.execution_kind as $kind | $kinds | index($kind))' "$evidence_b" >/dev/null; then
  echo '::error::Context B executed an action or reused local action state instead of relying on the remote action cache'
  exit 1
fi
if ! jq -e --argjson action_cache "$ACTION_EXECUTION_KIND_ACTION_CACHE" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.name.category == "javascript_product_descriptor" and $action.execution_kind == $action_cache)' "$evidence_b" >/dev/null; then
  echo '::error::Context B did not reuse the remote product descriptor action'
  exit 1
fi
descriptor_path="$("$buck" build --local-only --show-full-json-output "${target}[descriptor]" | jq -r 'to_entries[0].value')"
cp "$descriptor_path" "$descriptor_b"
if ! cmp -s "$descriptor_a" "$descriptor_b"; then
  echo '::error::Product descriptor bytes differ between independent roots'
  exit 1
fi

# The suite is a build action. The tiny buck2 test adapter may execute locally;
# it reads result.json/report.json and never runs Vitest.
run_proof_command "$test_evidence_b" proof-b-test test --target-platforms effect_utils//buck2/platforms:host_platform --local-only "$test_target"
if ! jq -e 'select(.Event.data.Instant.data.TestResult.name == "effect_utils//packages/@overeng/content-address:test" and .Event.data.Instant.data.TestResult.status == 1)' "$test_evidence_b" >/dev/null; then
  echo '::error::Context B did not report the cached representative unit test as passing'
  exit 1
fi
if ! jq -e --argjson action_cache "$ACTION_EXECUTION_KIND_ACTION_CACHE" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.name.category == "unit_test_verdict" and $action.execution_kind == $action_cache)' "$test_evidence_b" >/dev/null; then
  echo '::error::Context B did not reuse the remote unit-test verdict action'
  exit 1
fi
if jq -e --argjson kinds "$EXECUTED_OR_LOCAL_CACHE_KINDS" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.name.category == "unit_test_verdict" and ($kinds | index($action.execution_kind)))' "$test_evidence_b" >/dev/null; then
  echo '::error::Context B executed the representative unit suite locally'
  exit 1
fi

# An unrelated mutation must not alter the representative test action key.
printf '%s\n' '' "// trusted irrelevant-mutation proof ${GITHUB_RUN_ID:?GITHUB_RUN_ID not set}-${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT not set}" >> README.md
run_proof_command "$test_evidence_c" proof-irrelevant-mutation test --target-platforms effect_utils//buck2/platforms:host_platform --local-only "$test_target"
if ! jq -e 'select(.Event.data.Instant.data.TestResult.name == "effect_utils//packages/@overeng/content-address:test" and .Event.data.Instant.data.TestResult.status == 1)' "$test_evidence_c" >/dev/null; then
  echo '::error::The irrelevant mutation prevented the cached representative unit test from passing'
  exit 1
fi
if jq -e --argjson kinds "$EXECUTED_OR_LOCAL_CACHE_KINDS" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.name.category == "unit_test_verdict" and ($kinds | index($action.execution_kind)))' "$test_evidence_c" >/dev/null; then
  echo '::error::The irrelevant mutation reran the representative unit-test verdict action'
  exit 1
fi
echo 'Fresh-root remote action and test-cache proof passed'
