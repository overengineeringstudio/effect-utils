#!/usr/bin/env bash
# Tests for setup.nix git hash caching with inner cache awareness
#
# Validates the two-tier caching design (R5, R11 compliance):
# - Outer tier: git hash
# - Inner tier: per-task content caches (e.g., pnpm-install/*.hash)
#
# Tasks should only be skipped when BOTH tiers are valid.
# If innerCacheDirs is empty, inner cache check is skipped (git-hash-only mode).
set -euo pipefail

# ============================================================================
# Test helpers
# ============================================================================

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

# ============================================================================
# Simulate the gitHashStatus function from setup.nix
# This mirrors the logic so we can test it in isolation
# ============================================================================

simulate_git_hash_status() {
  local hash_file="$1"
  local cache_root="$2"
  local current_hash="$3"
  local force_setup="${4:-${FORCE_SETUP:-}}"
  local inner_cache_dirs="${5-pnpm-install}"  # space-separated list, empty = git-hash-only

  # Allow bypass via FORCE_SETUP=1
  [ "$force_setup" = "1" ] && return 1

  local cached
  cached=$(cat "$hash_file" 2>/dev/null || echo "")

  # If git hash differs, always run
  if [ "$current_hash" != "$cached" ]; then
    return 1
  fi

  # If no inner cache dirs configured, use git-hash-only mode
  if [ -z "$inner_cache_dirs" ]; then
    return 0
  fi

  # Check each configured inner cache dir for *.hash files
  for dir_name in $inner_cache_dirs; do
    local cache_dir="$cache_root/$dir_name"
    # Directory must exist and contain at least one .hash file
    if [ -d "$cache_dir" ] && ls "$cache_dir"/*.hash >/dev/null 2>&1; then
      # Found valid inner cache - safe to skip
      return 0
    fi
  done

  # No valid inner caches found - run to populate them
  return 1
}

# ============================================================================
# Test cases
# ============================================================================

echo "Running setup-cache tests..."
echo ""

# Create temp directory structure
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT

cache_root="$test_dir/.direnv/task-cache"
hash_file="$cache_root/setup-git-hash"
pnpm_cache_dir="$cache_root/pnpm-install"

mkdir -p "$cache_root"

# Test 1: Fresh cache (no git hash file) -> should return 1 (run)
echo "Test 1: Fresh cache (no git hash file)"
set +e
simulate_git_hash_status "$hash_file" "$cache_root" "abc123"
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "fresh cache returns 1 (needs to run)"

# Test 2: Matching git hash but NO inner caches -> should return 1 (run)
echo ""
echo "Test 2: Matching git hash but no inner caches"
echo "abc123" > "$hash_file"
set +e
simulate_git_hash_status "$hash_file" "$cache_root" "abc123"
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "matching hash + no inner caches returns 1 (run to populate)"

# Test 3: Matching git hash AND inner caches with .hash files -> should return 0 (skip)
echo ""
echo "Test 3: Matching git hash + inner caches with .hash files"
mkdir -p "$pnpm_cache_dir"
echo "somehash" > "$pnpm_cache_dir/genie.hash"
set +e
simulate_git_hash_status "$hash_file" "$cache_root" "abc123"
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "matching hash + .hash files returns 0 (skip)"

# Test 4: Different git hash -> should return 1 (run) even with inner caches
echo ""
echo "Test 4: Different git hash (inner caches exist)"
set +e
simulate_git_hash_status "$hash_file" "$cache_root" "def456"
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "different hash returns 1 (needs to run)"

# Test 5: FORCE_SETUP=1 -> should return 1 (run) regardless of cache state
echo ""
echo "Test 5: FORCE_SETUP=1 bypasses cache"
set +e
simulate_git_hash_status "$hash_file" "$cache_root" "abc123" "1"
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "FORCE_SETUP=1 returns 1 (always run)"

# Test 6: Empty inner cache directory -> should return 1 (run)
echo ""
echo "Test 6: Empty inner cache directory"
rm -f "$pnpm_cache_dir"/*
set +e
simulate_git_hash_status "$hash_file" "$cache_root" "abc123"
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "empty inner cache dir returns 1 (run to populate)"

# Test 7: Inner cache with multiple .hash files -> should return 0 (skip)
echo ""
echo "Test 7: Multiple inner cache .hash files"
echo "hash1" > "$pnpm_cache_dir/genie.hash"
echo "hash2" > "$pnpm_cache_dir/megarepo.hash"
echo "hash3" > "$pnpm_cache_dir/utils.hash"
set +e
simulate_git_hash_status "$hash_file" "$cache_root" "abc123"
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "multiple .hash files returns 0 (skip)"

# Test 8: Inner cache with only non-.hash files -> should return 1 (run)
echo ""
echo "Test 8: Inner cache with only non-.hash files (false positive prevention)"
rm -f "$pnpm_cache_dir"/*
echo "not a hash" > "$pnpm_cache_dir/some.lock"
echo "also not" > "$pnpm_cache_dir/partial.tmp"
set +e
simulate_git_hash_status "$hash_file" "$cache_root" "abc123"
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "non-.hash files returns 1 (run to populate proper caches)"

# Test 9: Git-hash-only mode (empty innerCacheDirs) -> should return 0 when hash matches
echo ""
echo "Test 9: Git-hash-only mode (innerCacheDirs='')"
rm -rf "$pnpm_cache_dir"  # Remove inner caches entirely
set +e
simulate_git_hash_status "$hash_file" "$cache_root" "abc123" "" ""
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "git-hash-only mode returns 0 when hash matches"

# Test 10: Git-hash-only mode with different hash -> should return 1 (run)
echo ""
echo "Test 10: Git-hash-only mode with different hash"
set +e
simulate_git_hash_status "$hash_file" "$cache_root" "xyz999" "" ""
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "git-hash-only mode returns 1 when hash differs"

# Test 11: Multiple inner cache dirs, only one has .hash files -> should return 0 (skip)
echo ""
echo "Test 11: Multiple inner cache dirs, partial population"
mkdir -p "$pnpm_cache_dir"
mkdir -p "$cache_root/other-cache"
echo "hash1" > "$pnpm_cache_dir/genie.hash"
# other-cache has no .hash files
set +e
simulate_git_hash_status "$hash_file" "$cache_root" "abc123" "" "pnpm-install other-cache"
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "at least one valid inner cache returns 0 (skip)"

# Test 12: Multiple inner cache dirs, none have .hash files -> should return 1 (run)
echo ""
echo "Test 12: Multiple inner cache dirs, none populated"
rm -f "$pnpm_cache_dir"/*.hash
echo "not a hash" > "$cache_root/other-cache/lock.file"
set +e
simulate_git_hash_status "$hash_file" "$cache_root" "abc123" "" "pnpm-install other-cache"
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "no valid inner caches returns 1 (run)"

echo ""
echo "All setup-cache tests passed"
