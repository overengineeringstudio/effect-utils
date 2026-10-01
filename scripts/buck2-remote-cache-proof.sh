#!/usr/bin/env bash
set -euo pipefail

source_root="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE not set}"
cd "$source_root"
bun scripts/buck2-cache-posture.ts "$source_root"
grep -Fq 'allow_cache_uploads = true' .buckconfig.local || { echo '::error::publisher cache posture was not selected'; exit 1; }
buck="${BUCK2_BIN:?BUCK2_BIN not set}"
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
trap 'rm -f "$evidence_a" "$test_evidence_a" "$evidence_b" "$test_evidence_b" "$test_evidence_c"; rm -rf "$context_b"' EXIT

# Context A executes locally and uploads run-unique source inputs.
# Buck's recent-log index is zero-based: inspect the command just completed.
"$buck" kill
rm -rf buck-out
"$buck" build --local-only "$target"
"$buck" log show --recent 0 > "$evidence_a"
if ! jq -e 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.execution_kind == "ACTION_EXECUTION_KIND_LOCAL" and $action.cache_upload_result == "UPLOAD_RESULT_UPLOADED")' "$evidence_a" >/dev/null; then
  echo '::error::Context A did not report a successful upload for a locally executed action'
  exit 1
fi
"$buck" test --target-platforms effect_utils//buck2/platforms:host_platform --local-only "$test_target"
"$buck" log show --recent 0 > "$test_evidence_a"
if ! jq -e 'select(.Event.data.SpanEnd.data.TestRun.command_report.details.command_kind.command.LocalCommand)' "$test_evidence_a" >/dev/null; then
  echo '::error::Context A did not execute the representative unit-test lane locally'
  exit 1
fi

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
"$buck" build --local-only "$target"
"$buck" log show --recent 0 > "$evidence_b"
if ! jq -e 'select(.Event.data.SpanEnd.data.ActionExecution.execution_kind == "ACTION_EXECUTION_KIND_ACTION_CACHE")' "$evidence_b" >/dev/null; then
  echo '::error::Context B did not report a remote action-cache hit'
  exit 1
fi
if jq -e 'select(.Event.data.SpanEnd.data.ActionExecution.execution_kind as $kind | $kind == "ACTION_EXECUTION_KIND_LOCAL" or $kind == "ACTION_EXECUTION_KIND_REMOTE" or $kind == "ACTION_EXECUTION_KIND_LOCAL_DEP_FILE" or $kind == "ACTION_EXECUTION_KIND_LOCAL_ACTION_CACHE" or $kind == "ACTION_EXECUTION_KIND_LOCAL_WORKER" or $kind == "ACTION_EXECUTION_KIND_REMOTE_WORKER")' "$evidence_b" >/dev/null; then
  echo '::error::Context B executed an action or reused local action state instead of relying on the remote action cache'
  exit 1
fi

# The representative unit test must hit the remote test cache, not run locally.
"$buck" test --target-platforms effect_utils//buck2/platforms:host_platform --local-only "$test_target"
"$buck" log show --recent 0 > "$test_evidence_b"
if ! jq -e 'select(.Event.data.Instant.data.TestResult.name == "effect_utils//packages/@overeng/content-address:test" and .Event.data.Instant.data.TestResult.status == 1)' "$test_evidence_b" >/dev/null; then
  echo '::error::Context B did not report the cached representative unit test as passing'
  exit 1
fi
if jq -e 'select(.Event.data.SpanEnd.data.TestRun.command_report.details.command_kind.command.LocalCommand)' "$test_evidence_b" >/dev/null; then
  echo '::error::Context B executed the representative unit test locally instead of using the remote test cache'
  exit 1
fi

# An unrelated mutation must not alter the representative test action key.
printf '%s\n' '' "// trusted irrelevant-mutation proof ${GITHUB_RUN_ID:?GITHUB_RUN_ID not set}-${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT not set}" >> README.md
"$buck" test --target-platforms effect_utils//buck2/platforms:host_platform --local-only "$test_target"
"$buck" log show --recent 0 > "$test_evidence_c"
if ! jq -e 'select(.Event.data.Instant.data.TestResult.name == "effect_utils//packages/@overeng/content-address:test" and .Event.data.Instant.data.TestResult.status == 1)' "$test_evidence_c" >/dev/null; then
  echo '::error::The irrelevant mutation prevented the cached representative unit test from passing'
  exit 1
fi
if jq -e 'select(.Event.data.SpanEnd.data.TestRun.command_report.details.command_kind.command.LocalCommand)' "$test_evidence_c" >/dev/null; then
  echo '::error::The irrelevant mutation changed the representative unit-test action key'
  exit 1
fi
echo 'Fresh-root remote action and test-cache proof passed'
