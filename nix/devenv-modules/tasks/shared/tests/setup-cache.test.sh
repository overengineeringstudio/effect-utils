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

simulate_tool_identity() {
  local tool_name="$1"
  local tool_path="$2"
  local resolved_path

  resolved_path=$(python - <<'PY' "$tool_path"
import pathlib
import sys

print(pathlib.Path(sys.argv[1]).resolve())
PY
)

  {
    printf 'tool %s path %s\n' "$tool_name" "$tool_path"
    printf 'tool %s resolved %s\n' "$tool_name" "$resolved_path"

    if [ -f "$resolved_path" ] && [[ "$resolved_path" != /nix/store/* ]]; then
      printf 'tool %s sha256 %s\n' "$tool_name" "$(shasum -a 256 "$resolved_path" | awk '{print $1}')"
    fi
  } | shasum -a 256 | awk '{print $1}'
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
echo "Test 8: Mutable tool target content invalidates fingerprint"
tool_dir="$test_dir/tool"
mkdir -p "$tool_dir/bin" "$tool_dir/pkg-v1" "$tool_dir/pkg-v2"
printf 'echo v1\n' > "$tool_dir/pkg-v1/tool"
printf 'echo v2\n' > "$tool_dir/pkg-v2/tool"
chmod +x "$tool_dir/pkg-v1/tool" "$tool_dir/pkg-v2/tool"
ln -s ../pkg-v1/tool "$tool_dir/bin/tool"

tool_fp_v1=$(simulate_tool_identity tool "$tool_dir/bin/tool")
ln -sf ../pkg-v2/tool "$tool_dir/bin/tool"
tool_fp_v2=$(simulate_tool_identity tool "$tool_dir/bin/tool")

if [ "$tool_fp_v1" = "$tool_fp_v2" ]; then
  echo "FAIL: retargeting mutable tool should change fingerprint"
  exit 1
fi
echo "  ok: retargeting mutable tool changes fingerprint"

echo ""
echo "Test 9: Nix store style tool path fingerprints by resolved path"
store_dir="$test_dir/nix/store/hash-demo-tool/bin"
mkdir -p "$store_dir"
printf 'echo store-tool\n' > "$store_dir/tool"
chmod +x "$store_dir/tool"
ln -s "$store_dir/tool" "$tool_dir/bin/store-tool"

store_fp_1=$(simulate_tool_identity store-tool "$tool_dir/bin/store-tool")
mv "$test_dir/nix/store/hash-demo-tool" "$test_dir/nix/store/hash-demo-tool-2"
ln -sf "$test_dir/nix/store/hash-demo-tool-2/bin/tool" "$tool_dir/bin/store-tool"
store_fp_2=$(simulate_tool_identity store-tool "$tool_dir/bin/store-tool")

if [ "$store_fp_1" = "$store_fp_2" ]; then
  echo "FAIL: changing resolved store path should change fingerprint"
  exit 1
fi
echo "  ok: resolved store path change invalidates fingerprint"

echo ""
echo "All setup-cache tests passed"
