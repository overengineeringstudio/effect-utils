#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-invalidation-e2e.sh REPO_ROOT BUCK2_BIN}"
buck2_bin="${2:?usage: buck2-invalidation-e2e.sh REPO_ROOT BUCK2_BIN}"
stage0_config="${BUCK2_STAGE0_CONFIG:?BUCK2_STAGE0_CONFIG is required}"
target="//buck2/evidence:package_evidence"
isolation="invalidation-e2e-$$-$RANDOM"
tracked_source="$repo_root/buck2/evidence/source.txt"
sha256_bin="${SHA256_BIN:-sha256sum}"
awk_bin="${AWK_BIN:-awk}"

[ -x "$buck2_bin" ] || {
  echo "buck2-invalidation-e2e: Buck2 binary is not executable: $buck2_bin" >&2
  exit 64
}
[ -f "$stage0_config" ] || {
  echo "buck2-invalidation-e2e: stage-0 config is missing: $stage0_config" >&2
  exit 64
}
[ -f "$tracked_source" ] || {
  echo "buck2-invalidation-e2e: fixture is missing: $tracked_source" >&2
  exit 64
}

tracked_digest="$($sha256_bin "$tracked_source" | "$awk_bin" '{ print $1 }')"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/buck2-invalidation-repo.XXXXXX")"
source_path="$test_root/buck2/evidence/source.txt"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -d "$test_root" ]; then
    cd "$test_root"
    "$buck2_bin" --isolation-dir "$isolation" clean >/dev/null 2>&1 || true
    "$buck2_bin" --isolation-dir "$isolation" kill >/dev/null 2>&1 || true
    rm -rf "$test_root"
  fi
  current_tracked_digest="$($sha256_bin "$tracked_source" | "$awk_bin" '{ print $1 }')"
  if [ "$current_tracked_digest" != "$tracked_digest" ]; then
    echo "buck2-invalidation-e2e: tracked fixture changed during isolated proof" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The RED/GREEN control is intentionally destructive, so execute it in a
# disposable Buck project rather than racing another worktree user by editing
# the checked-in fixture in place.
cp -p "$repo_root/.buckconfig" "$test_root/.buckconfig"
cp -R "$repo_root/buck2" "$test_root/buck2"
cp -R "$repo_root/toolchains" "$test_root/toolchains"
baseline_source="$test_root/baseline-source.txt"
cp -p "$source_path" "$baseline_source"

build_and_observe() {
  phase="$1"
  output="$($buck2_bin \
    --isolation-dir "$isolation" \
    --config-file "$stage0_config" \
    build "$target" \
    --show-full-output \
    --local-only \
    --no-remote-cache)"
  artifact="$(printf '%s\n' "$output" | "$awk_bin" '$1 == "root//buck2/evidence:package_evidence" { print $2 }')"
  [ -n "$artifact" ] && [ -f "$artifact" ] || {
    echo "buck2-invalidation-e2e: $phase did not report a materialized artifact" >&2
    return 1
  }
  what_ran="$($buck2_bin --isolation-dir "$isolation" log what-ran)"
  action_count="$(printf '%s\n' "$what_ran" | "$awk_bin" 'NF { count += 1 } END { print count + 0 }')"
  artifact_digest="$($sha256_bin "$artifact" | "$awk_bin" '{ print $1 }')"
  printf '%s %s\n' "$artifact_digest" "$action_count"
}

cd "$test_root"
read -r baseline_digest _baseline_actions < <(build_and_observe baseline)

printf '\nbuck2 invalidation probe %s\n' "$isolation" >> "$source_path"
read -r mutated_digest mutated_actions < <(build_and_observe mutation)
[ "$mutated_actions" -eq 1 ] || {
  echo "buck2-invalidation-e2e: mutation ran $mutated_actions actions, expected exactly 1" >&2
  exit 1
}
[ "$mutated_digest" != "$baseline_digest" ] || {
  echo "buck2-invalidation-e2e: mutation did not change the artifact digest" >&2
  exit 1
}

cp -p "$baseline_source" "$source_path"
read -r restored_digest restored_actions < <(build_and_observe restore)
[ "$restored_actions" -eq 1 ] || {
  echo "buck2-invalidation-e2e: restore ran $restored_actions actions, expected exactly 1" >&2
  exit 1
}
[ "$restored_digest" = "$baseline_digest" ] || {
  echo "buck2-invalidation-e2e: restored artifact digest differs from baseline" >&2
  exit 1
}

echo "buck2-invalidation-e2e: PASS mutation_actions=1 restore_actions=1 digest_restored=true"
