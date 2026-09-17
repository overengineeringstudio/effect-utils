#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/genie/ci-scripts/evict-pnpm-deps-cached-outputs.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin"

cat >"$test_dir/bin/nix" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'nix' >>"$CALLS"
printf ' <%s>' "$@" >>"$CALLS"
printf '\n' >>"$CALLS"
case "${1:-}" in
  eval)
    [ "${EVAL_FAIL:-0}" != 1 ] || exit 1
    printf '[{"attrName":"deps","drvPath":"/nix/store/test-pnpm-deps-v1.drv"}]\n'
    ;;
  path-info)
    if [ "${2:-}" = "--derivation" ]; then
      printf '/nix/store/top.drv\n'
    elif [[ "${2:-}" == *'^*' ]]; then
      printf '/nix/store/test-output\n'
    elif [ "$(cat "$STATE")" = present ]; then
      printf '%s\n' "${2:-}"
    else
      exit 1
    fi
    ;;
  store)
    [ "${DELETE_FAIL:-0}" != 1 ] || exit 1
    [ "${DELETE_SURVIVES:-0}" = 1 ] || printf 'absent\n' >"$STATE"
    ;;
  build)
    if [[ " $* " == *' --rebuild '* ]]; then
      [ "${REBUILD_FAIL:-0}" != 1 ] || exit 1
      [ "${REBUILD_PROVES_CHECK:-1}" != 1 ] || printf "checking outputs of '/nix/store/test-pnpm-deps-v1.drv'\n"
    fi
    ;;
  *) exit 64 ;;
esac
EOF

cat >"$test_dir/bin/nix-store" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'nix-store' >>"$CALLS"
printf ' <%s>' "$@" >>"$CALLS"
printf '\n' >>"$CALLS"
if [ "${1:-}" = -q ] && [ "${2:-}" = --outputs ]; then
  printf '/nix/store/test-output\n'
elif [ "${1:-}" = -qR ]; then
  printf '/nix/store/test-pnpm-deps-v1.drv\n'
else
  exit 64
fi
EOF
chmod +x "$test_dir/bin/nix" "$test_dir/bin/nix-store"

export PATH="$test_dir/bin:$PATH"
export CALLS="$test_dir/calls"
export STATE="$test_dir/state"
export GITHUB_STEP_SUMMARY="$test_dir/summary"

reset_case() {
  : >"$CALLS"
  : >"$GITHUB_STEP_SUMMARY"
  printf 'present\n' >"$STATE"
}

assert_contains() {
  local needle="$1"
  local file="$2"
  if ! grep -Fq -- "$needle" "$file"; then
    echo "FAIL: missing '$needle' in $file" >&2
    exit 1
  fi
}

assert_fails() {
  if "$@"; then
    echo "FAIL: command unexpectedly succeeded: $*" >&2
    exit 1
  fi
}

echo 'Test 1: strict deletion is primary and proves absence'
reset_case
"$SCRIPT" '.#fixture' >"$test_dir/output"
assert_contains 'freshness_mode=strict-delete drv=/nix/store/test-pnpm-deps-v1.drv out=/nix/store/test-output' "$test_dir/output"
assert_contains 'delete_verified=true drv=/nix/store/test-pnpm-deps-v1.drv out=/nix/store/test-output' "$test_dir/output"
assert_contains 'nix <eval> <--json> <.#fixture.passthru.depsBuildEntries>' "$CALLS"


echo 'Test 2: a successful delete must actually remove the output'
reset_case
assert_fails env DELETE_SURVIVES=1 "$SCRIPT" '.#fixture' >"$test_dir/output" 2>&1
assert_contains 'cached pnpm-deps output still present after successful eviction' "$test_dir/output"


echo 'Test 3: immutable output falls back to a proved rebuild check'
reset_case
env DELETE_FAIL=1 "$SCRIPT" '.#fixture' >"$test_dir/output"
assert_contains 'freshness_mode=rebuild-check reason=immutable-global-store' "$test_dir/output"
assert_contains '::warning title=pnpm deps freshness fallback::' "$test_dir/output"
assert_contains 'rebuild_check_verified=true drv=/nix/store/test-pnpm-deps-v1.drv out=/nix/store/test-output' "$test_dir/output"
assert_contains 'nix <build> <--no-link> <--rebuild> <-L> </nix/store/test-pnpm-deps-v1.drv^*>' "$CALLS"
assert_contains '- mode: `rebuild-check`' "$GITHUB_STEP_SUMMARY"
assert_contains '- output: `/nix/store/test-output`' "$GITHUB_STEP_SUMMARY"
assert_contains '- derivation: `/nix/store/test-pnpm-deps-v1.drv`' "$GITHUB_STEP_SUMMARY"


echo 'Test 4: rebuild success without check-mode evidence fails closed'
reset_case
assert_fails env DELETE_FAIL=1 REBUILD_PROVES_CHECK=0 "$SCRIPT" '.#fixture' >"$test_dir/output" 2>&1
assert_contains 'rebuild check did not prove builder execution' "$test_dir/output"


echo 'Test 5: rebuild failure is observable and fails closed'
reset_case
assert_fails env DELETE_FAIL=1 REBUILD_FAIL=1 "$SCRIPT" '.#fixture' >"$test_dir/output" 2>&1
assert_contains 'rebuild check failed for cached pnpm-deps output' "$test_dir/output"


echo 'Test 6: an absent output emits a machine-readable mode'
reset_case
printf 'absent\n' >"$STATE"
"$SCRIPT" '.#fixture' >"$test_dir/output"
assert_contains 'freshness_mode=not-present drv=/nix/store/test-pnpm-deps-v1.drv out=/nix/store/test-output' "$test_dir/output"


echo 'Test 7: cold mode rebuilds the dependency before and after eviction'
reset_case
"$SCRIPT" --cold-build '.#fixture' >"$test_dir/output"
assert_contains 'cold-building pnpm deps: deps' "$test_dir/output"
build_count="$(grep -Fc 'nix <build> <--no-link> </nix/store/test-pnpm-deps-v1.drv^*> <--option> <substituters> <https://cache.nixos.org>' "$CALLS")"
if [ "$build_count" -ne 2 ]; then
  echo "FAIL: expected two cold dependency builds, got $build_count" >&2
  exit 1
fi

echo 'evict-pnpm-deps-cached-outputs helper tests passed'
