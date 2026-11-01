#!/usr/bin/env bash
set -euo pipefail
# Disposable profiles only: neither production pins nor the live capability cell
# are modified. Four tiny cold-materializer builds fit the PR-only tools lane.
source_root="${DEVENV_ROOT:-${GITHUB_WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}}"
bun="${BUN_BIN:-$(command -v bun)}"
buck="${BUCK2_NATIVE_BIN:-${BUCK2_BIN:?BUCK2_BIN not set}}"
require_remote_hits=()
# The machine wrapper may select posture for the production root; this proof
# already copied that posture and must run its disposable projection unchanged.
if [ -z "${BUCK2_NATIVE_BIN:-}" ] && [ -x "${buck%/bin/buck2}/libexec/buck2" ]; then
  buck="${buck%/bin/buck2}/libexec/buck2"
fi
case "${1:-}" in
  '') ;;
  --require-remote-hits) require_remote_hits=(--require-remote-hits) ;;
  *) echo "usage: $0 [--require-remote-hits]" >&2; exit 2 ;;
esac
scratch_base="$source_root/tmp/buck2-capability-identity"
mkdir -p "$scratch_base"
scratch="$(mktemp -d "$scratch_base/run.XXXXXX")"
fixture="$scratch/root"
profiles="$scratch/profiles"
evidence="${BUCK2_CAPABILITY_IDENTITY_EVIDENCE:-${RUNNER_TEMP:-$source_root/.devenv}/buck2-capability-identity-proof.json}"
mkdir -p "$fixture/.buck2" "$scratch/logs" "$scratch/ambient" "$(dirname "$evidence")"
cleanup() {
  local status=$?
  (cd "$fixture" && "$buck" kill) >/dev/null 2>&1 || true
  chmod -R u+w "$scratch" 2>/dev/null || true
  rm -rf "$scratch"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp -R "$source_root/buck2" "$fixture/buck2"
# Watcher selection is daemon-startup configuration, not a build-time -c override.
# This tiny disposable tree needs no host Watchman service or startup handshake.
while IFS= read -r line; do
  if [ "$line" = '  file_watcher = watchman' ]; then
    printf '%s\n' '  file_watcher = notify'
  else
    printf '%s\n' "$line"
  fi
done <"$source_root/.buckconfig" >"$fixture/.buckconfig"
# Reuse the selected reader/writer admission, including trusted RE configuration.
if [ -f "$source_root/.buckconfig.local" ]; then cp "$source_root/.buckconfig.local" "$fixture/.buckconfig.local"; fi
touch "$fixture/.buckroot"
# Keep the production configured provider and hermetic_action unchanged; only the
# fixture target registry is minimal so unrelated package roots are unnecessary.
cat >"$fixture/buck2/toolchains/BUCK" <<'BUCK'
load(":configured.bzl", "support_tool")
support_tool(name = "tool_action_env", protocol = "gnu/coreutils-env/v9", tool_id = "action-env", visibility = ["PUBLIC"])
support_tool(name = "tool_bun", protocol = "effect-utils/buck2-bun/v1", tool_id = "bun", visibility = ["PUBLIC"])
support_tool(name = "tool_node", protocol = "nodejs/node/v24", tool_id = "node", visibility = ["PUBLIC"])
BUCK
"$bun" "$source_root/scripts/buck2-capability-identity-proof.ts" prepare "$source_root/.buck2/capabilities" "$profiles"
node_path="$(cat "$profiles/node-store-path")"
ln -s "$node_path" "$scratch/ambient/g1-proof-node"
export PATH="$scratch/ambient:$PATH"
# Prove B is executable in the exact parent environment inherited by the daemon.
[ "$(g1-proof-node --eval 'process.stdout.write("tool-b-executed")')" = tool-b-executed ]

# Native event sinks are independent of log rotation. Each wiped materializer
# has its own opaque root incarnation, and failed commands still finalize evidence.
run_identity_build() {
  local phase="$1" status=0 build_id native_id root_id cache_read_policy=enabled
  shift
  # This phase proves dependency execution, not ActionCache reuse.
  if [ "$phase" = dependency ]; then cache_read_policy=disabled-by-design; fi
  build_id="$("$bun" -e 'console.log(crypto.randomUUID())')"
  root_id="$("$bun" -e 'import {createHash} from "node:crypto"; console.log(createHash("sha256").update(crypto.randomUUID()).digest("hex"))')"
  native_id="$scratch/$phase.trace"
  if [ -n "${CI_BUCK2_CACHE_EVIDENCE_PATH:-}" ]; then
    native_id="$("$bun" "$source_root/genie/ci-scripts/buck2-cache-evidence.ts" --output "$CI_BUCK2_CACHE_EVIDENCE_PATH" --register-native "$build_id")"
  fi
  local sink="$scratch/logs/$phase.json-lines"
  : > "$sink"
  BUCK_WRAPPER_UUID="$build_id" CI_BUCK2_CACHE_EVIDENCE_PATH="" "$buck" build \
    --event-log "$sink" --write-build-id "$native_id" "$@" || status=$?
  mv "$sink" "$scratch/logs/$phase.jsonl"
  if [ -n "${CI_BUCK2_CACHE_EVIDENCE_PATH:-}" ]; then
    if ! "$bun" "$source_root/genie/ci-scripts/buck2-cache-evidence.ts" \
      --output "$CI_BUCK2_CACHE_EVIDENCE_PATH" --write-shard "$scratch/logs/$phase.jsonl" \
      --shard-build-id "$build_id" --native-exit-code "$status" --root-id "$root_id" \
      --context "capability-identity-$phase" --cache-read-policy "$cache_read_policy" --fresh-root >/dev/null; then
      "$bun" "$source_root/genie/ci-scripts/buck2-cache-evidence.ts" --output "$CI_BUCK2_CACHE_EVIDENCE_PATH" --evidence-gap proof-evidence-capture-failed || true
      if [ "$status" -eq 0 ]; then return 1; fi
    fi
  fi
  return "$status"
}
for phase in baseline selected unused action-env; do
  # No local action state may hide an unchanged action: all four native outcomes
  # must be emitted again (and must be remote hits in the trusted writer proof).
  (cd "$fixture" && "$buck" kill) >/dev/null 2>&1 || true
  rm -rf "$fixture/buck-out" "$fixture/.buck2/capabilities"
  cp -R "$profiles/$phase" "$fixture/.buck2/capabilities"
  (
    cd "$fixture"
    run_identity_build "$phase" --local-only --config buck2.file_watcher=notify \
      effect_utils//buck2/tests/capability_identity:selected \
      effect_utils//buck2/tests/capability_identity:unselected \
      effect_utils//buck2/tests/capability_identity:dependency_negative \
      effect_utils//buck2/tests/capability_identity:dependency_positive
  )
done
# A remote cached success is not evidence that the dependency check executed in
# this parent PATH. Force a separate cold native run with remote reads disabled.
(cd "$fixture" && "$buck" kill) >/dev/null 2>&1 || true
rm -rf "$fixture/buck-out"
(
  cd "$fixture"
  run_identity_build dependency --local-only --no-remote-cache --config buck2.file_watcher=notify \
    --config buck2.remote_cache_enabled=false \
    effect_utils//buck2/tests/capability_identity:dependency_negative \
    effect_utils//buck2/tests/capability_identity:dependency_positive
)
"$bun" "$source_root/scripts/buck2-capability-identity-proof.ts" assert "$scratch/logs" "$evidence" "${require_remote_hits[@]}"
