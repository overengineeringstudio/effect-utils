#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-megarepo-invalidation-e2e.sh REPO_ROOT BUCK2_BIN [BUCK_ARGS...]}"
buck2_bin="${2:?usage: buck2-megarepo-invalidation-e2e.sh REPO_ROOT BUCK2_BIN [BUCK_ARGS...]}"
shift 2
buck_args=("$@")
target="//packages/@overeng/megarepo:mr"
binary_target="$target[binary]"
isolation="megarepo-invalidation-$$-$RANDOM"
backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/buck2-megarepo-invalidation.XXXXXX")"
scratch_root="$(mktemp -d "${TMPDIR:-/tmp}/buck2-megarepo-worktree.XXXXXX")"
work_root="$scratch_root/repo"
sha256_bin="${SHA256_BIN:-sha256sum}"
awk_bin="${AWK_BIN:-awk}"

[ -x "$buck2_bin" ] || {
  echo "buck2-megarepo-invalidation-e2e: Buck2 binary is not executable: $buck2_bin" >&2
  exit 64
}
git -C "$repo_root" worktree add --detach "$work_root" HEAD >/dev/null
source_path="$work_root/packages/@overeng/megarepo/src/lib/version.ts"
irrelevant_path="$work_root/packages/@overeng/megarepo/src/lib/ref.unit.test.ts"
unused_path="$work_root/packages/@overeng/megarepo/src/mod.ts"
[ -f "$source_path" ] && [ -f "$irrelevant_path" ] && [ -f "$unused_path" ] || {
  echo "buck2-megarepo-invalidation-e2e: mutation fixtures are missing" >&2
  exit 64
}

cp -p "$source_path" "$backup_dir/version.ts"
cp -p "$irrelevant_path" "$backup_dir/ref.unit.test.ts"
cp -p "$unused_path" "$backup_dir/mod.ts"
original_source_digest="$($sha256_bin "$source_path" | "$awk_bin" '{ print $1 }')"
original_irrelevant_digest="$($sha256_bin "$irrelevant_path" | "$awk_bin" '{ print $1 }')"
original_unused_digest="$($sha256_bin "$unused_path" | "$awk_bin" '{ print $1 }')"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  cp -p "$backup_dir/version.ts" "$source_path" || status=1
  cp -p "$backup_dir/ref.unit.test.ts" "$irrelevant_path" || status=1
  cp -p "$backup_dir/mod.ts" "$unused_path" || status=1
  (cd "$work_root" && "$buck2_bin" --isolation-dir "$isolation" clean >/dev/null 2>&1) || true
  (cd "$work_root" && "$buck2_bin" --isolation-dir "$isolation" kill >/dev/null 2>&1) || true
  if [ "$($sha256_bin "$source_path" | "$awk_bin" '{ print $1 }')" != "$original_source_digest" ] ||
    [ "$($sha256_bin "$irrelevant_path" | "$awk_bin" '{ print $1 }')" != "$original_irrelevant_digest" ] ||
    [ "$($sha256_bin "$unused_path" | "$awk_bin" '{ print $1 }')" != "$original_unused_digest" ]; then
    echo "buck2-megarepo-invalidation-e2e: cleanup did not restore fixture bytes" >&2
    status=1
  fi
  git -C "$repo_root" worktree remove --force "$work_root" >/dev/null 2>&1 || status=1
  rm -rf "$backup_dir" "$scratch_root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

build_and_observe() {
  phase="$1"
  output="$($buck2_bin \
    --isolation-dir "$isolation" \
    build "${buck_args[@]}" "$target" "$binary_target" \
    --show-full-output --local-only --no-remote-cache)"
  archive="$(printf '%s\n' "$output" | "$awk_bin" '$1 == "root//packages/@overeng/megarepo:mr" { print $2 }')"
  binary="$(printf '%s\n' "$output" | "$awk_bin" '$1 == "root//packages/@overeng/megarepo:mr[binary]" { print $2 }')"
  [ -f "$archive" ] && [ -x "$binary" ] || {
    echo "buck2-megarepo-invalidation-e2e: $phase did not materialize both outputs" >&2
    return 1
  }
  what_ran="$($buck2_bin --isolation-dir "$isolation" log what-ran)"
  action_count="$(printf '%s\n' "$what_ran" | "$awk_bin" 'NF { count += 1 } END { print count + 0 }')"
  archive_digest="$($sha256_bin "$archive" | "$awk_bin" '{ print $1 }')"
  version="$(env -i PATH=/nonexistent "$binary" --version | "$awk_bin" '{ print $1 }')"
  printf '%s %s %s\n' "$archive_digest" "$action_count" "$version"
}

cd "$work_root"
read -r baseline_digest _ baseline_version < <(build_and_observe baseline)
read -r warm_digest warm_actions warm_version < <(build_and_observe warm)
[ "$warm_actions" -eq 0 ] && [ "$warm_digest" = "$baseline_digest" ] && [ "$warm_version" = "$baseline_version" ] || {
  echo "buck2-megarepo-invalidation-e2e: warm build was not a zero-action stable-digest reuse" >&2
  exit 1
}

touch -m "$source_path"
read -r mtime_digest mtime_actions mtime_version < <(build_and_observe mtime)
[ "$mtime_actions" -eq 0 ] && [ "$mtime_digest" = "$baseline_digest" ] && [ "$mtime_version" = "$baseline_version" ] || {
  echo "buck2-megarepo-invalidation-e2e: mtime-only change invalidated the action" >&2
  exit 1
}

sed -i "s/MR_VERSION = '0.1.0'/MR_VERSION = '0.1.0-buck2probe'/" "$source_path"
read -r mutated_digest mutated_actions mutated_version < <(build_and_observe relevant)
expected_mutated_version="${baseline_version/0.1.0/0.1.0-buck2probe}"
[ "$mutated_actions" -eq 2 ] && [ "$mutated_digest" != "$baseline_digest" ] &&
  [ "$mutated_version" = "$expected_mutated_version" ] || {
  echo "buck2-megarepo-invalidation-e2e: relevant edit lacked exact typecheck plus bundle invalidation" >&2
  echo "  actions=$mutated_actions version=$mutated_version expected=$expected_mutated_version" >&2
  exit 1
}

cp -p "$backup_dir/version.ts" "$source_path"
read -r restored_digest restored_actions restored_version < <(build_and_observe restore)
[ "$restored_actions" -eq 2 ] && [ "$restored_digest" = "$baseline_digest" ] &&
  [ "$restored_version" = "$baseline_version" ] || {
  echo "buck2-megarepo-invalidation-e2e: source restoration did not restore the original artifact" >&2
  exit 1
}

printf '\nexport const buck2TypecheckOnlyProbe = %s\n' "$RANDOM" >> "$unused_path"
read -r typecheck_digest typecheck_actions typecheck_version < <(build_and_observe typecheck-only)
[ "$typecheck_actions" -eq 1 ] && [ "$typecheck_digest" = "$baseline_digest" ] &&
  [ "$typecheck_version" = "$baseline_version" ] || {
  echo "buck2-megarepo-invalidation-e2e: unreachable production edit did not stay typecheck-only" >&2
  exit 1
}

printf '\nexport const buck2TypeErrorProbe: string = 1\n' >> "$unused_path"
if "$buck2_bin" --isolation-dir "$isolation" build "${buck_args[@]}" "$target" \
  --local-only --no-remote-cache >/dev/null 2>&1; then
  echo "buck2-megarepo-invalidation-e2e: invalid TypeScript unexpectedly built" >&2
  exit 1
fi
type_error_what_ran="$($buck2_bin --isolation-dir "$isolation" log what-ran)"
type_error_actions="$(printf '%s\n' "$type_error_what_ran" | "$awk_bin" 'NF { count += 1 } END { print count + 0 }')"
[ "$type_error_actions" -eq 1 ] || {
  echo "buck2-megarepo-invalidation-e2e: type-error RED control did not fail only the typecheck action" >&2
  exit 1
}
case "$type_error_what_ran" in
  *typescript_project_check*) ;;
  *)
    echo "buck2-megarepo-invalidation-e2e: type-error RED control lacks the typecheck action identity" >&2
    exit 1
    ;;
esac
cp -p "$backup_dir/mod.ts" "$unused_path"
read -r typecheck_restored_digest _ typecheck_restored_version < <(build_and_observe typecheck-restore)
[ "$typecheck_restored_digest" = "$baseline_digest" ] &&
  [ "$typecheck_restored_version" = "$baseline_version" ] || {
  echo "buck2-megarepo-invalidation-e2e: typecheck fixture restoration changed the bundle" >&2
  exit 1
}

printf '\n// buck2 irrelevant invalidation probe: %s\n' "$isolation" >> "$irrelevant_path"
read -r irrelevant_digest irrelevant_actions irrelevant_version < <(build_and_observe irrelevant)
[ "$irrelevant_actions" -eq 0 ] && [ "$irrelevant_digest" = "$baseline_digest" ] &&
  [ "$irrelevant_version" = "$baseline_version" ] || {
  echo "buck2-megarepo-invalidation-e2e: excluded test input invalidated the production action" >&2
  exit 1
}

echo "buck2-megarepo-invalidation-e2e: PASS warm=0 mtime=0 relevant=2 restore=2 typecheck_only=1 type_error=RED irrelevant=0 digest_restored=true"
