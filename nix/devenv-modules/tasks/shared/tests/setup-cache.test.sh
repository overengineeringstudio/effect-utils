#!/usr/bin/env bash
# Tests for setup.nix outer setup fingerprint caching.
#
# The outer cache only answers whether shell-entry inputs changed. Task-local
# status checks own output validation, so this test intentionally stays focused
# on fingerprint persistence and FORCE_SETUP behavior.
set -euo pipefail

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected exit code: $expected"
    echo "  actual exit code:   $actual"
    exit 1
  fi
  echo "  ok: $label"
}

simulate_setup_outer_cache_hit() {
  local fingerprint_file="$1"
  local current_fingerprint="$2"
  local force_setup="${3-}"  # Explicit parameter only, ignore env var for testing

  [ "$force_setup" = "1" ] && return 1

  local cached
  cached=$(cat "$fingerprint_file" 2>/dev/null || echo "")
  [ "$current_fingerprint" = "$cached" ]
}

echo "Running setup-cache tests..."
echo ""

test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT

cache_root="$test_dir/.direnv/task-cache"
fingerprint_file="$cache_root/setup-fingerprint"

mkdir -p "$cache_root"

echo "Test 1: Fresh cache (no fingerprint file)"
set +e
simulate_setup_outer_cache_hit "$fingerprint_file" "abc123"
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "fresh cache returns 1 (needs to run)"

echo ""
echo "Test 2: Matching fingerprint"
echo "abc123" > "$fingerprint_file"
set +e
simulate_setup_outer_cache_hit "$fingerprint_file" "abc123"
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "matching fingerprint returns 0 (skip)"

echo ""
echo "Test 3: Different fingerprint"
set +e
simulate_setup_outer_cache_hit "$fingerprint_file" "def456"
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "different fingerprint returns 1 (needs to run)"

echo ""
echo "Test 4: FORCE_SETUP=1 bypasses cache"
set +e
simulate_setup_outer_cache_hit "$fingerprint_file" "abc123" "1"
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "FORCE_SETUP=1 returns 1 (always run)"

echo ""
echo "Test 5: Empty fingerprint file"
: > "$fingerprint_file"
set +e
simulate_setup_outer_cache_hit "$fingerprint_file" "abc123"
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "empty fingerprint file returns 1 (needs to run)"

echo ""
echo "Test 6: Trailing newline in cache file still matches"
printf 'abc123\n' > "$fingerprint_file"
set +e
simulate_setup_outer_cache_hit "$fingerprint_file" "abc123"
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "cached newline-trimmed fingerprint returns 0 (skip)"

echo ""
echo "Test 7: Similar but different fingerprint does not false-hit"
set +e
simulate_setup_outer_cache_hit "$fingerprint_file" "abc1234"
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "different fingerprint text returns 1 (needs to run)"

echo ""
echo "All setup-cache tests passed"
