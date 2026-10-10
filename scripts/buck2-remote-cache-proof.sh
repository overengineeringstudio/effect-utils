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
readonly NATIVE_RUST_TARGETS='["effect_utils//rust/content-address-core:lib","effect_utils//rust/buck2-tools/core:lib","effect_utils//scripts/fixtures/rust-foreign/b/crates/shared:lib"]'

# Compare actual RE action keys, not output tiny_digest or command cache flags.
# Native buildscript RUN and nonadmitted transitive crates are deliberately not
# counted as admitted compute; their rows remain in the sanitized full artifact.
# Each focused target must supply both compile and dependency-argument evidence.
assert_native_rust_proof() {
  local log
  # Buildscript execution is never part of native compile admission.
  for log in "$1" "$2"; do
    if jq -e --argjson local "$ACTION_EXECUTION_KIND_LOCAL" --argjson uploaded "$UPLOAD_RESULT_UPLOADED" '
      select(.Event.data.SpanEnd.data.ActionExecution as $action |
        $action.name.category == "buildscript" and
        ($action.execution_kind != $local or $action.cache_upload_result == $uploaded))
    ' "$log" >/dev/null; then
      echo '::error::Native nonadmitted buildscript unexpectedly reused remote state or uploaded'
      return 1
    fi
  done
  if ! jq -en --slurpfile writer "$1" --slurpfile reader "$2" \
    --argjson targets "$NATIVE_RUST_TARGETS" \
    --argjson local "$ACTION_EXECUTION_KIND_LOCAL" \
    --argjson uploaded "$UPLOAD_RESULT_UPLOADED" \
    --argjson remote "$ACTION_EXECUTION_KIND_ACTION_CACHE" '
      def rows:
        [.[] | .Event as $event | $event.data.SpanEnd.data.ActionExecution
          | select(. != null) | . as $action
          | .key.owner.TargetLabel as $owner
          | ($owner.label.package + ":" + $owner.label.name) as $target
          | select(($targets | index($target)) != null)
          | select(.name.category == "rustc" or .name.category == "deps")
          | {span: $event.span_id, target: $target, category: .name.category,
             identifier: (.name.identifier // ""), configuration: $owner.configuration.full_name,
             execution: .execution_kind, upload: .cache_upload_result, failed: .failed,
             digest: ([.commands[]?.details.command_kind.command
               | (.OmittedLocalCommand // .LocalCommand // .RemoteCommand // .WorkerCommand)
               | .action_digest | select(. != null)] | last)}]
        | unique_by(.span);
      def complete:
        . as $rows | all($targets[]; . as $target |
          all(["rustc", "deps"][]; . as $category |
            any($rows[]; .target == $target and .category == $category)))
        and all(.[]; (.configuration | type) == "string"
          and (.configuration | length) > 0
          and (.digest | type) == "string"
          and (.digest | test("^[a-f0-9]{64}:[0-9]+$"))
          and .failed != true);
      def keys:
        map([.target, .category, .identifier, .configuration, .digest]) | sort;
      ($writer | rows) as $a | ($reader | rows) as $b |
      ($a | complete) and ($b | complete)
      and all($a[]; .execution == $local and .upload == $uploaded)
      and all($b[]; .execution == $remote and .upload != $uploaded)
      and (($a | keys) == ($b | keys))
    ' >/dev/null; then
    echo '::error::Native Rust proof requires complete LOCAL+uploaded writer and kind3 reader rustc/deps rows with identical action identities/digests'
    return 1
  fi
}

# Offline replay uses the same assertions as the fresh-root build below.
assert_context_b_build() {
  local evidence="$1" excluded_categories
  excluded_categories="$(bun -e 'import { localMaterializationCategories } from "./genie/ci-scripts/buck2-action-evidence.ts"; console.log(JSON.stringify(localMaterializationCategories))')"
  if ! jq -e --argjson action_cache "$ACTION_EXECUTION_KIND_ACTION_CACHE" 'select(.Event.data.SpanEnd.data.ActionExecution.execution_kind == $action_cache)' "$evidence" >/dev/null; then
    echo '::error::Context B did not report a remote action-cache hit'
    return 1
  fi
  # Native rows have a separate strict proof below. Unadmitted transitive
  # compile/buildscript actions are not evidence of successful JS cache reuse.
  if jq -e --argjson kinds "$EXECUTED_OR_LOCAL_CACHE_KINDS" --argjson excluded "$excluded_categories" 'select(.Event.data.SpanEnd.data.ActionExecution as $action | ($excluded | index($action.name.category) | not) and (["rustc", "deps", "buildscript"] | index($action.name.category) | not) and ($kinds | index($action.execution_kind)))' "$evidence" >/dev/null; then
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
if [ "${1:-}" = --assert-native-rust-proof ]; then
  assert_native_rust_proof "${2:?writer event log path required}" "${3:?reader event log path required}"
  exit
fi

bun scripts/buck2-cache-posture.ts "$source_root"
grep -Fq 'allow_cache_uploads = true' .buckconfig.local || { echo '::error::publisher cache posture was not selected'; exit 1; }
buck="${BUCK2_BIN:?BUCK2_BIN not set}"
context_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof-context-b"
target='effect_utils//packages/@overeng/ci-tools:ci-tools-candidate'
test_target='effect_utils//packages/@overeng/content-address:test'
rust_targets=('effect_utils//rust/content-address-core:lib' 'effect_utils//rust/buck2-tools/core:lib' 'effect_utils//scripts/fixtures/rust-foreign/b/crates/shared:lib')
# Prelude's default library output is check metadata, not a linkable rlib.
rust_rlib_targets=("${rust_targets[@]/%/[static]}")
proof_source="$source_root/packages/@overeng/ci-tools/bin/ci-tools.ts"
test_proof_source="$source_root/packages/@overeng/content-address/src/mod.unit.test.ts"
# A comment can disappear during bundling, leaving the descriptor action key
# unchanged. This disposable side effect survives bundling and changes integrity.
printf '%s\n' '' "console.debug('trusted remote-cache proof ${GITHUB_RUN_ID:?GITHUB_RUN_ID not set}-${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT not set}')" >> "$proof_source"
printf '%s\n' '' "// trusted test-cache proof ${GITHUB_RUN_ID:?GITHUB_RUN_ID not set}-${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT not set}" >> "$test_proof_source"
# Run-unique native source inputs ensure the writer genuinely seeds compile
# actions, rather than silently accepting an existing remote result.
for rust_source in rust/content-address-core/src/lib.rs rust/buck2-tools/core/src/lib.rs scripts/fixtures/rust-foreign/b/crates/shared/src/lib.rs; do
  printf '%s\n' '' "// trusted native Rust cache proof ${GITHUB_RUN_ID:?GITHUB_RUN_ID not set}-${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT not set}" >> "$source_root/$rust_source"
done
evidence_a="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof-a.jsonl"
test_evidence_a="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-a.jsonl"
evidence_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof-b.jsonl"
test_evidence_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-b.jsonl"
test_evidence_c="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-c.jsonl"
test_red_evidence="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-red.jsonl"
test_source_backup="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-source.ts"
descriptor_a="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-product-descriptor-a.json"
descriptor_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-product-descriptor-b.json"
rust_bytes_a="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-rust-output-bytes-a.txt"
rust_bytes_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-rust-output-bytes-b.txt"
trap 'if [ -f "$test_source_backup" ]; then cp "$test_source_backup" "$test_proof_source"; fi; rm -f "$evidence_a" "$test_evidence_a" "$evidence_b" "$test_evidence_b" "$test_evidence_c" "$test_red_evidence" "$test_source_backup" "$descriptor_a" "$descriptor_b" "$rust_bytes_a" "$rust_bytes_b"; if [ -d "$context_b" ]; then (cd "$context_b" && "$buck" kill); fi; rm -rf "$context_b"' EXIT

# Preserve action keys/outcomes before each proof context's native logs are removed.
# Local invocations without a CI artifact declaration retain the existing proof flow.
capture_cache_evidence() {
  if [ -n "${CI_BUCK2_CACHE_EVIDENCE_PATH:-}" ]; then
    local fresh=()
    case "$2" in proof-a-build|proof-b-build) fresh=(--fresh-root);; esac
    if ! bun "$source_root/genie/ci-scripts/buck2-cache-evidence.ts" \
      --events "$1" --output "$CI_BUCK2_CACHE_EVIDENCE_PATH" --context "$2" "${fresh[@]}"; then
      echo "::error::Buck2 cache evidence capture failed for $2" >&2
      bun "$source_root/genie/ci-scripts/buck2-cache-evidence.ts" \
        --output "$CI_BUCK2_CACHE_EVIDENCE_PATH" --evidence-gap proof-evidence-capture-failed || true
      return 1
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
    if ! capture_cache_evidence "$evidence" "$context"; then
      if [ "$status" -eq 0 ]; then status=1; fi
    fi
  else
    echo "::warning::Buck2 native event log unavailable for $context" >&2
    if [ -n "${CI_BUCK2_CACHE_EVIDENCE_PATH:-}" ]; then
      bun "$source_root/genie/ci-scripts/buck2-cache-evidence.ts" \
        --output "$CI_BUCK2_CACHE_EVIDENCE_PATH" --evidence-gap proof-native-log-unavailable || true
    fi
    if [ "$status" -eq 0 ]; then return 1; fi
  fi
  return "$status"
}
# Only target labels and output content hashes survive this comparison. Native
# --show-full-json-output paths stay in the pipe, never in the CI artifact.
capture_rust_output_bytes() {
  local label output hash
  "$buck" build --local-only --show-full-json-output "${rust_rlib_targets[@]}" |
    jq -er --argjson targets "$NATIVE_RUST_TARGETS" '
      if keys == ($targets | map(. + "[static]") | sort) and all(.[]; type == "string" and length > 0)
      then to_entries | sort_by(.key)[] | [.key, .value] | @tsv
      else error("Native Rust proof requires every declared output") end
    ' |
    while IFS=$'\t' read -r label output; do
      [ -f "$output" ] || { echo '::error::Native Rust proof output is missing' >&2; return 1; }
      hash="$(sha256sum "$output")" || return 1
      printf '%s\t%s\n' "$label" "${hash%% *}"
    done
}

# Context A executes locally and uploads run-unique source inputs.
# `log show --recent` uses zero-based history; 0 is the command just run.
"$buck" kill
rm -rf buck-out
# Pinned CommonBuildOptions maps these flags to skip_cache_read=true and
# skip_cache_write=false. Thus stable deps actions must execute/upload too.
run_proof_command "$evidence_a" proof-a-build build --local-only --no-remote-cache --write-to-cache-anyway "$target" "${rust_targets[@]}" "${rust_rlib_targets[@]}"
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
capture_rust_output_bytes > "$rust_bytes_a"
# Analysis must retain the noncompilation API without admitting those actions.
# Provider artifact ownership proves these subtargets use the native deny twin;
# unlike a build, this does not run Clippy or rustdoc as a proof prerequisite.
for subtarget in clippy.json diag.json doc; do
  providers="$("$buck" audit providers --provider DefaultInfo "effect_utils//rust/content-address-core:lib[$subtarget]")"
  if ! printf '%s\n' "$providers" | grep -Fq 'bound to effect_utils//rust/content-address-core:__cache_native_diagnostics_lib '; then
    echo "::error::Rust noncompilation subtarget $subtarget escaped its native deny twin"
    exit 1
  fi
done
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
unset BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH
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
grep -Fq 'default_allow_cache_upload = false' .buckconfig.local || { echo '::error::reader default cache uploads were not disabled'; exit 1; }
if grep -Fq 'http_headers' .buckconfig.local; then echo '::error::reader cache inherited publisher auth'; exit 1; fi

# Cache-eligible build actions must hit remotely; materialization stays local by policy.
run_proof_command "$evidence_b" proof-b-build build --local-only "$target" "${rust_targets[@]}" "${rust_rlib_targets[@]}"
assert_context_b_build "$evidence_b"
assert_native_rust_proof "$evidence_a" "$evidence_b"
capture_rust_output_bytes > "$rust_bytes_b"
if ! cmp -s "$rust_bytes_a" "$rust_bytes_b"; then
  echo '::error::Native Rust library output bytes differ between independent roots'
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
# A remote reader's byte match proves transfer, not independent compiler
# reproducibility. Recompile in the second worktree with empty local state and
# all remote reads/writes disabled; the fixture exposes file!() in its rlib.
"$buck" kill
rm -rf buck-out
run_proof_command "$evidence_b" proof-b-native-local build --local-only --no-remote-cache "${rust_targets[@]}" "${rust_rlib_targets[@]}"
if ! jq -en --slurpfile events "$evidence_b" --argjson targets "$NATIVE_RUST_TARGETS" --argjson local "$ACTION_EXECUTION_KIND_LOCAL" '
  [$events[] | .Event.data.SpanEnd.data.ActionExecution
    | select(.name.category == "rustc" or .name.category == "deps")
    | select(.key.owner.TargetLabel as $owner |
      ($targets | index($owner.label.package + ":" + $owner.label.name)) != null)] as $rows |
  all($targets[]; . as $target |
    all(["rustc", "deps"][]; . as $category |
      any($rows[]; (.key.owner.TargetLabel.label.package + ":" + .key.owner.TargetLabel.label.name) == $target
        and .name.category == $category and .execution_kind == $local and .failed != true)))
' >/dev/null; then
  echo '::error::Independent second-root Rust byte proof did not compile locally'
  exit 1
fi
capture_rust_output_bytes > "$rust_bytes_b"
if ! cmp -s "$rust_bytes_a" "$rust_bytes_b"; then
  echo '::error::Independent Rust compilation bytes differ across worktree roots (including file!())'
  exit 1
fi
printf '%s\n' 'Native Rust rlib byte identity (writer = remote reader = independent local compiler):'
cat "$rust_bytes_b"
echo 'Fresh-root remote action, native Rust rustc/deps and test-cache proof passed'
