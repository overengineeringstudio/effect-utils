#!/usr/bin/env bash
set -euo pipefail

source_root="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE not set}"
cd "$source_root"
# `log show` emits numeric protobuf enums in the pinned Buck2 release:
# https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_data/data.proto
readonly ACTION_EXECUTION_KIND_LOCAL=1
readonly ACTION_EXECUTION_KIND_ACTION_CACHE=3
readonly UPLOAD_RESULT_UPLOADED=1
# LOCAL, REMOTE, LOCAL_DEP_FILE, LOCAL_WORKER, LOCAL_ACTION_CACHE, REMOTE_WORKER.
readonly EXECUTED_OR_LOCAL_CACHE_KINDS='[1,2,7,8,10,11]'

# Offline replay uses the same assertions as the fresh-root build below.
assert_context_b_build() {
  local evidence="$1" excluded_categories
  excluded_categories="$(bun -e 'import { localMaterializationCategories } from "./genie/ci-scripts/buck2-action-evidence.ts"; console.log(JSON.stringify(localMaterializationCategories))')"
  if ! jq -e --argjson action_cache "$ACTION_EXECUTION_KIND_ACTION_CACHE" 'select(.Event.data.SpanEnd.data.ActionExecution.execution_kind == $action_cache)' "$evidence" >/dev/null; then
    echo '::error::Context B did not report a remote action-cache hit'
    return 1
  fi
  if jq -e --argjson kinds "$EXECUTED_OR_LOCAL_CACHE_KINDS" --argjson excluded "$excluded_categories" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | ($excluded | index($action.name.category) | not) and ($kinds | index($action.execution_kind)))' "$evidence" >/dev/null; then
    echo '::error::Context B executed a cache-eligible action or reused local action state instead of relying on the remote action cache'
    return 1
  fi
  if ! jq -e --argjson action_cache "$ACTION_EXECUTION_KIND_ACTION_CACHE" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.name.category == "javascript_product_descriptor" and $action.execution_kind == $action_cache)' "$evidence" >/dev/null; then
    echo '::error::Context B did not reuse the remote product descriptor action'
    return 1
  fi
}

if [ "${1:-}" = --assert-context-b-build ]; then
  assert_context_b_build "${2:?native event log path required}"
  exit
fi

buck="${BUCK2_BIN:?BUCK2_BIN not set}"
context_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof-context-b"
target='effect_utils//packages/@overeng/ci-tools:ci-tools-candidate'
test_target='effect_utils//packages/@overeng/content-address:test'
proof_source="$source_root/packages/@overeng/ci-tools/bin/ci-tools.ts"
test_proof_source="$source_root/packages/@overeng/content-address/src/mod.unit.test.ts"
evidence_a="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof-a.jsonl"
test_evidence_a="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-a.jsonl"
evidence_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof-b.jsonl"
test_evidence_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-b.jsonl"
test_evidence_c="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-c.jsonl"
test_red_evidence="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-red.jsonl"
test_source_backup="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-source.ts"
descriptor_a="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-product-descriptor-a.json"
descriptor_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-product-descriptor-b.json"
descriptor_evidence="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-descriptor-cache-events.jsonl"
reader_evidence="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-reader-target-union.jsonl"
cleanup_proof() {
  if [ -f "$test_source_backup" ]; then cp "$test_source_backup" "$test_proof_source"; fi
  rm -f "$test_source_backup" "$descriptor_a" "$descriptor_b"
  for file in "$evidence_a" "$test_evidence_a" "$evidence_b" "$test_evidence_b" "$test_evidence_c" "$test_red_evidence" "$descriptor_evidence" "$reader_evidence"; do
    rm -f "$file" "$file.json-lines" "$file.buck-trace-id"
  done
  if [ -d "$context_b" ]; then (cd "$context_b" && "$buck" kill); fi
  rm -rf "$context_b"
}
trap cleanup_proof EXIT

# Use Buck's supported extra sink outside rotation for every deliberately included
# root. The private raw temporary is retained only for the assertions below; only
# sanitized atomically finalized shards enter the uploaded artifact.
run_proof_command() {
  local evidence="$1" context="$2" status=0 build_id native_id root_id
  local projector="$source_root/genie/ci-scripts/buck2-cache-evidence.ts"
  shift 2
  build_id="$(bun -e 'console.log(crypto.randomUUID())')"
  root_id="$proof_root_id"
  native_id="${evidence}.buck-trace-id"
  if [ -n "${CI_BUCK2_CACHE_EVIDENCE_PATH:-}" ]; then
    native_id="$(bun "$projector" --output "$CI_BUCK2_CACHE_EVIDENCE_PATH" --register-native "$build_id")"
  fi
  : > "${evidence}.json-lines"
  local command=("$buck")
  if [ "$context" = proof-reader-target-union ]; then command=(timeout 600 "$buck"); fi
  BUCK_WRAPPER_UUID="$build_id" CI_BUCK2_CACHE_EVIDENCE_PATH="" \
    "${command[@]}" "$@" --event-log "${evidence}.json-lines" --write-build-id "$native_id" || status=$?
  mv "${evidence}.json-lines" "$evidence"
  if [ -n "${CI_BUCK2_CACHE_EVIDENCE_PATH:-}" ]; then
    local fresh=()
    case "$context" in proof-a-build|proof-b-build|proof-reader-target-union) fresh=(--fresh-root);; esac
    if ! bun "$projector" --output "$CI_BUCK2_CACHE_EVIDENCE_PATH" \
      --write-shard "$evidence" --shard-build-id "$build_id" --native-exit-code "$status" \
      --context "$context" --root-id "$root_id" "${fresh[@]}" >/dev/null; then
      bun "$projector" --output "$CI_BUCK2_CACHE_EVIDENCE_PATH" --evidence-gap proof-evidence-capture-failed || true
      if [ "$status" -eq 0 ]; then return 1; fi
    fi
  fi
  return "$status"
}

# Readers render these workspace-sibling declarations into their editor views;
# building the union observes unchanged source identities, not the run-unique
# inputs used below. A remote hit is valid trusted presence, not a fresh upload.
# --build-reader-targets exposes this exact added step for read-only measurement
# without the protected writer credential or the rest of the mutation proof.
build_reader_targets() {
  local targets_file="$RUNNER_TEMP/buck2-reader-targets.txt" started elapsed status=0
  local reader_targets=()
  started="$(date +%s)"
  bun -e 'import {readerDeclarationTargets} from "./genie/buck2/typescript-admissions.ts"; for (const target of readerDeclarationTargets) console.log(target.startsWith("//") ? `effect_utils${target}` : target)' > "$targets_file"
  mapfile -t reader_targets < "$targets_file"
  rm "$targets_file"
  if [ "${#reader_targets[@]}" -eq 0 ]; then
    echo '::error::Reader declaration composition produced no targets'
    return 1
  fi
  "$buck" kill
  rm -rf buck-out
  proof_root_id="$(bun -e 'import {createHash} from "node:crypto"; console.log(createHash("sha256").update(crypto.randomUUID()).digest("hex"))')"
  run_proof_command "$reader_evidence" proof-reader-target-union build \
    --target-platforms effect_utils//buck2/platforms:host_platform --local-only "${reader_targets[@]}" || status=$?
  elapsed=$(( $(date +%s) - started ))
  echo "::notice::[ci] reader declaration target union (${#reader_targets[@]} targets) completed in $elapsed s (status $status; native deadline 600 s)"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### Reader declaration target union\n- Targets: %s\n- Duration: %s s\n- Status: %s\n- Native deadline: 600 s\n' \
      "${#reader_targets[@]}" "$elapsed" "$status" >> "$GITHUB_STEP_SUMMARY"
  fi
  return "$status"
}

bun scripts/buck2-cache-posture.ts "$source_root"
if [ "${1:-}" = --build-reader-targets ]; then
  build_reader_targets
  exit
fi
grep -Fq 'allow_cache_uploads = true' .buckconfig.local || { echo '::error::publisher cache posture was not selected'; exit 1; }
build_reader_targets
# Reuse the trusted writer admission to prime the tiny identity graph, then
# require unchanged users to hit remotely after each cold local materializer.
# Bound added runtime independently of the larger product/test cache proof.
timeout 60 bash "$source_root/scripts/buck2-capability-identity-proof.sh" --require-remote-hits
# A comment can disappear during bundling, leaving the descriptor action key
# unchanged. This disposable side effect survives bundling and changes integrity.
printf '%s\n' '' "console.debug('trusted remote-cache proof ${GITHUB_RUN_ID:?GITHUB_RUN_ID not set}-${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT not set}')" >> "$proof_source"
printf '%s\n' '' "// trusted test-cache proof ${GITHUB_RUN_ID:?GITHUB_RUN_ID not set}-${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT not set}" >> "$test_proof_source"

# Context A executes locally and uploads run-unique source inputs.
# Every explicit cold root receives a new opaque incarnation token.
"$buck" kill
rm -rf buck-out
proof_root_id="$(bun -e 'import {createHash} from "node:crypto"; console.log(createHash("sha256").update(crypto.randomUUID()).digest("hex"))')"
run_proof_command "$evidence_a" proof-a-build build --local-only "$target"
if ! jq -e --argjson local "$ACTION_EXECUTION_KIND_LOCAL" --argjson uploaded "$UPLOAD_RESULT_UPLOADED" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.execution_kind == $local and $action.cache_upload_result == $uploaded)' "$evidence_a" >/dev/null; then
  echo '::error::Context A did not report a successful upload for a locally executed action'
  exit 1
fi
if ! jq -e --argjson local "$ACTION_EXECUTION_KIND_LOCAL" --argjson uploaded "$UPLOAD_RESULT_UPLOADED" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.name.category == "javascript_product_descriptor" and $action.execution_kind == $local and $action.cache_upload_result == $uploaded)' "$evidence_a" >/dev/null; then
  echo '::error::Context A did not execute and upload the product descriptor action'
  exit 1
fi
descriptor_path="$(run_proof_command "$descriptor_evidence" proof-a-descriptor build --local-only --show-full-json-output "${target}[descriptor]" | jq -r 'to_entries[0].value')"
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

# Cache-eligible build actions must hit remotely; materialization stays local by policy.
proof_root_id="$(bun -e 'import {createHash} from "node:crypto"; console.log(createHash("sha256").update(crypto.randomUUID()).digest("hex"))')"
run_proof_command "$evidence_b" proof-b-build build --local-only "$target"
assert_context_b_build "$evidence_b"
descriptor_path="$(run_proof_command "$descriptor_evidence" proof-b-descriptor build --local-only --show-full-json-output "${target}[descriptor]" | jq -r 'to_entries[0].value')"
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
