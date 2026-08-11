#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-otel-scrape-invalidation-e2e.sh REPO_ROOT BUCK2_BIN [BUCK_ARGS...]}"
buck2_bin="${2:?usage: buck2-otel-scrape-invalidation-e2e.sh REPO_ROOT BUCK2_BIN [BUCK_ARGS...]}"
shift 2
buck_args=("$@")
target="//packages/@overeng/otel-scrape:otel-scrape"
canonical_target="root//packages/@overeng/otel-scrape:otel-scrape"
isolation="otel-scrape-invalidation-$$-$RANDOM"
backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/buck2-otel-scrape-invalidation.XXXXXX")"
scratch_root="$(mktemp -d "${TMPDIR:-/tmp}/buck2-otel-scrape-worktree.XXXXXX")"
work_root="$scratch_root/repo"
sha256_bin="${SHA256_BIN:-sha256sum}"
awk_bin="${AWK_BIN:-awk}"
stat_bin="${STAT_BIN:-stat}"

[ -x "$buck2_bin" ] || {
  echo "buck2-otel-scrape-invalidation-e2e: Buck2 binary is not executable: $buck2_bin" >&2
  exit 64
}
git -C "$repo_root" worktree add --detach "$work_root" HEAD >/dev/null
source_path="$work_root/packages/@overeng/otel-scrape/src/lib.rs"
integration_path="$work_root/packages/@overeng/otel-scrape/tests/cli.rs"
[ -f "$source_path" ] && [ -f "$integration_path" ] || {
  echo "buck2-otel-scrape-invalidation-e2e: mutation fixtures are missing" >&2
  exit 64
}

cp -p "$source_path" "$backup_dir/lib.rs"
cp -p "$integration_path" "$backup_dir/cli.rs"
original_source_digest="$($sha256_bin "$source_path" | "$awk_bin" '{ print $1 }')"
original_integration_digest="$($sha256_bin "$integration_path" | "$awk_bin" '{ print $1 }')"
original_source_metadata="$($stat_bin -c '%f %y' "$source_path")"
original_integration_metadata="$($stat_bin -c '%f %y' "$integration_path")"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  cp -p "$backup_dir/lib.rs" "$source_path" || status=1
  cp -p "$backup_dir/cli.rs" "$integration_path" || status=1
  (cd "$work_root" && "$buck2_bin" --isolation-dir "$isolation" clean >/dev/null 2>&1) || true
  (cd "$work_root" && "$buck2_bin" --isolation-dir "$isolation" kill >/dev/null 2>&1) || true
  if [ "$($sha256_bin "$source_path" | "$awk_bin" '{ print $1 }')" != "$original_source_digest" ] ||
    [ "$($sha256_bin "$integration_path" | "$awk_bin" '{ print $1 }')" != "$original_integration_digest" ] ||
    [ "$($stat_bin -c '%f %y' "$source_path")" != "$original_source_metadata" ] ||
    [ "$($stat_bin -c '%f %y' "$integration_path")" != "$original_integration_metadata" ]; then
    echo "buck2-otel-scrape-invalidation-e2e: cleanup did not restore fixture bytes, mode, and mtime" >&2
    status=1
  fi
  git -C "$repo_root" worktree remove --force "$work_root" >/dev/null 2>&1 || status=1
  rm -rf "$backup_dir" "$scratch_root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

assert_no_cargo_invocation() {
  local phase="$1"
  local what_ran="$2"
  if printf '%s\n' "$what_ran" |
    grep -Eiq "(^|[[:space:]\"'])([^[:space:]\"']*/)?cargo([[:space:]\"',]|$)"; then
    echo "buck2-otel-scrape-invalidation-e2e: $phase invoked Cargo instead of native Buck actions" >&2
    return 1
  fi
}

assert_relevant_action_set() {
  local phase="$1"
  local what_ran="$2"
  local lib_actions
  local link_actions
  lib_actions="$(printf '%s\n' "$what_ran" |
    grep -F "$canonical_target" -v |
    grep -F 'root//packages/@overeng/otel-scrape:lib ' |
    grep -F -c '(rustc rlib [pic])' || true)"
  link_actions="$(printf '%s\n' "$what_ran" |
    grep -F "$canonical_target" |
    grep -F -c '(rustc link [pic])' || true)"
  if [ "$lib_actions" -ne 1 ] || [ "$link_actions" -ne 1 ]; then
    echo "buck2-otel-scrape-invalidation-e2e: $phase did not execute the exact lib-compile + binary-link action set" >&2
    printf '%s\n' "$what_ran" >&2
    return 1
  fi
}

assert_binary_leaf_action_set() {
  local phase="$1"
  local what_ran="$2"
  local link_actions
  local library_actions
  link_actions="$(printf '%s\n' "$what_ran" |
    grep -F "$canonical_target" |
    grep -F -c '(rustc link [pic])' || true)"
  library_actions="$(printf '%s\n' "$what_ran" |
    grep -F 'root//packages/@overeng/otel-scrape:lib ' |
    grep -F -c '(rustc rlib [pic])' || true)"
  if [ "$link_actions" -ne 1 ] || [ "$library_actions" -ne 0 ]; then
    echo "buck2-otel-scrape-invalidation-e2e: $phase did not stay within the binary-link leaf" >&2
    printf '%s\n' "$what_ran" >&2
    return 1
  fi
}

build_and_observe() {
  local phase="$1"
  local revision_override="${2:-}"
  local output
  local binary
  local what_ran
  local action_count
  local binary_digest
  local binary_version
  local phase_args=()
  if [ -n "$revision_override" ]; then
    phase_args=(-c "buck2_build.revision=$revision_override")
  fi
  output="$($buck2_bin \
    --isolation-dir "$isolation" \
    build "${buck_args[@]}" "${phase_args[@]}" "$target" \
    --show-full-output --local-only --no-remote-cache)"
  binary="$(printf '%s\n' "$output" | "$awk_bin" -v target="$canonical_target" '$1 == target { print $2 }')"
  [ -n "$binary" ] && [ -f "$binary" ] && [ -x "$binary" ] || {
    echo "buck2-otel-scrape-invalidation-e2e: $phase did not materialize an executable binary" >&2
    return 1
  }
  what_ran="$($buck2_bin --isolation-dir "$isolation" log what-ran)"
  assert_no_cargo_invocation "$phase" "$what_ran"
  action_count="$(printf '%s\n' "$what_ran" | "$awk_bin" 'NF { count += 1 } END { print count + 0 }')"
  if [ "$phase" = relevant ] || [ "$phase" = restore ]; then
    [ "$action_count" -eq 2 ] || {
      echo "buck2-otel-scrape-invalidation-e2e: $phase expected exactly 2 actions, observed $action_count" >&2
      return 1
    }
    assert_relevant_action_set "$phase" "$what_ran"
  fi
  if [ "$phase" = provenance ] || [ "$phase" = provenance-restore ]; then
    [ "$action_count" -eq 1 ] || {
      echo "buck2-otel-scrape-invalidation-e2e: $phase expected exactly 1 action, observed $action_count" >&2
      return 1
    }
    assert_binary_leaf_action_set "$phase" "$what_ran"
  fi
  binary_digest="$($sha256_bin "$binary" | "$awk_bin" '{ print $1 }')"
  binary_version="$("$binary" --version | "$awk_bin" '{ print $2 }')"
  printf '%s %s %s\n' "$binary_digest" "$action_count" "$binary_version"
}

cd "$work_root"
read -r baseline_digest baseline_actions baseline_version < <(build_and_observe baseline)
read -r warm_digest warm_actions warm_version < <(build_and_observe warm)
[ "$warm_actions" -eq 0 ] && [ "$warm_digest" = "$baseline_digest" ] || {
  echo "buck2-otel-scrape-invalidation-e2e: warm build was not a zero-action stable-digest reuse" >&2
  exit 1
}

touch -m "$source_path"
read -r mtime_digest mtime_actions _mtime_version < <(build_and_observe mtime)
[ "$mtime_actions" -eq 0 ] && [ "$mtime_digest" = "$baseline_digest" ] || {
  echo "buck2-otel-scrape-invalidation-e2e: mtime-only change invalidated the production binary" >&2
  exit 1
}
cp -p "$backup_dir/lib.rs" "$source_path"

schema_url='https://opentelemetry.io/schemas/1.37.0'
probe_schema_url='https://opentelemetry.io/schemas/1.37.0-buck2probe'
schema_url_count="$({ grep -F -o "$schema_url" "$source_path" || true; } | "$awk_bin" 'END { print NR + 0 }')"
[ "$schema_url_count" -eq 1 ] || {
  echo "buck2-otel-scrape-invalidation-e2e: expected one runtime schema URL, found $schema_url_count" >&2
  exit 1
}
sed -i "s|$schema_url|$probe_schema_url|" "$source_path"
read -r mutated_digest mutated_actions _mutated_version < <(build_and_observe relevant)
[ "$mutated_actions" -eq 2 ] && [ "$mutated_digest" != "$baseline_digest" ] || {
  echo "buck2-otel-scrape-invalidation-e2e: relevant Rust edit did not rebuild and change the binary digest" >&2
  echo "  actions=$mutated_actions" >&2
  exit 1
}

cp -p "$backup_dir/lib.rs" "$source_path"
read -r restored_digest restored_actions _restored_version < <(build_and_observe restore)
[ "$restored_actions" -eq 2 ] && [ "$restored_digest" = "$baseline_digest" ] || {
  echo "buck2-otel-scrape-invalidation-e2e: source restoration did not restore the original binary" >&2
  exit 1
}

probe_revision="0000000000000000000000000000000000000001"
read -r provenance_digest provenance_actions provenance_version < <(
  build_and_observe provenance "$probe_revision"
)
[ "$provenance_actions" -eq 1 ] && [ "$provenance_digest" != "$baseline_digest" ] &&
  [ "$provenance_version" = "0.0.0+$probe_revision-dirty" ] || {
  echo "buck2-otel-scrape-invalidation-e2e: provenance change escaped the binary leaf or did not change identity" >&2
  echo "  actions=$provenance_actions version=$provenance_version" >&2
  exit 1
}

read -r provenance_restored_digest provenance_restored_actions provenance_restored_version < <(
  build_and_observe provenance-restore
)
[ "$provenance_restored_actions" -eq 1 ] &&
  [ "$provenance_restored_digest" = "$baseline_digest" ] &&
  [ "$provenance_restored_version" = "$baseline_version" ] || {
  echo "buck2-otel-scrape-invalidation-e2e: provenance restoration did not restore only the binary leaf" >&2
  exit 1
}

printf '\n// buck2 production invalidation exclusion probe: %s\n' "$isolation" >> "$integration_path"
read -r integration_digest integration_actions _integration_version < <(build_and_observe integration-only)
[ "$integration_actions" -eq 0 ] && [ "$integration_digest" = "$baseline_digest" ] || {
  echo "buck2-otel-scrape-invalidation-e2e: integration-only edit invalidated the production binary" >&2
  exit 1
}

echo "buck2-otel-scrape-invalidation-e2e: PASS baseline=$baseline_actions warm=0 mtime=0 relevant=$mutated_actions restore=$restored_actions provenance=1 provenance_restore=1 integration_only=0 digest_restored=true cargo_invocations=0"
