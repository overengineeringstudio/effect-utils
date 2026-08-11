#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-invalidation-e2e.sh REPO_ROOT BUCK2_BIN [BUCK_ARGS...]}"
buck2_bin="${2:?usage: buck2-invalidation-e2e.sh REPO_ROOT BUCK2_BIN [BUCK_ARGS...]}"
shift 2
buck_args=("$@")
target="//buck2/evidence:package_evidence"
source_path="$repo_root/buck2/evidence/source.txt"
isolation="invalidation-e2e-$$-$RANDOM"
backup="$(mktemp "${TMPDIR:-/tmp}/buck2-invalidation-source.XXXXXX")"
sha256_bin="${SHA256_BIN:-sha256sum}"
awk_bin="${AWK_BIN:-awk}"

[ -x "$buck2_bin" ] || {
  echo "buck2-invalidation-e2e: Buck2 binary is not executable: $buck2_bin" >&2
  exit 64
}
[ -f "$source_path" ] || {
  echo "buck2-invalidation-e2e: fixture is missing: $source_path" >&2
  exit 64
}

cp -p "$source_path" "$backup"
original_digest="$($sha256_bin "$source_path" | "$awk_bin" '{ print $1 }')"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  cp -p "$backup" "$source_path" || status=1
  "$buck2_bin" --isolation-dir "$isolation" clean >/dev/null 2>&1 || true
  "$buck2_bin" --isolation-dir "$isolation" kill >/dev/null 2>&1 || true
  rm -f "$backup"
  restored_digest="$($sha256_bin "$source_path" | "$awk_bin" '{ print $1 }')"
  if [ "$restored_digest" != "$original_digest" ]; then
    echo "buck2-invalidation-e2e: cleanup did not restore the fixture bytes" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

build_and_observe() {
  phase="$1"
  output="$($buck2_bin \
    --isolation-dir "$isolation" \
    build "${buck_args[@]}" "$target" \
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

cd "$repo_root"
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

cp -p "$backup" "$source_path"
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
