#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/genie/ci-scripts/nix-gc-race-retry.sh"
source "$SCRIPT"

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

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
}

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

echo "Running nix GC race retry helper tests..."
echo ""

echo "Test 1: retries invalid-store-path failures and succeeds on the next attempt"
retry_fixture="$test_dir/retry-fixture.sh"
cat > "$retry_fixture" <<EOF
#!/usr/bin/env bash
set -euo pipefail
attempt_file="$test_dir/retry-attempt"
attempt=1
if [ -f "\$attempt_file" ]; then
  attempt=\$(cat "\$attempt_file")
fi
if [ "\$attempt" -eq 1 ]; then
  echo 2 > "\$attempt_file"
  echo "error: path '/nix/store/retry-fixture-path' is not valid" >&2
  exit 1
fi
echo "retry recovered"
EOF
chmod +x "$retry_fixture"
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "retry-fixture" "$retry_fixture" >/dev/null
assert_eq "2" "$(cat "$test_dir/retry-attempt")" "invalid-store-path retry count"

echo "Test 2: retries cachix wrapper failures without an extracted store path"
cachix_fixture="$test_dir/cachix-fixture.sh"
cat > "$cachix_fixture" <<EOF
#!/usr/bin/env bash
set -euo pipefail
attempt_file="$test_dir/cachix-attempt"
attempt=1
if [ -f "\$attempt_file" ]; then
  attempt=\$(cat "\$attempt_file")
fi
if [ "\$attempt" -eq 1 ]; then
  echo 2 > "\$attempt_file"
  echo "Failed to convert config.cachix to JSON" >&2
  echo "while evaluating the option cachix.package" >&2
  exit 1
fi
echo "cachix recovered"
EOF
chmod +x "$cachix_fixture"
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "cachix-fixture" "$cachix_fixture" >/dev/null
assert_eq "2" "$(cat "$test_dir/cachix-attempt")" "cachix wrapper retry count"

echo "Test 3: preserves the original exit code when no GC-race signature is present"
non_retry_fixture="$test_dir/non-retry-fixture.sh"
cat > "$non_retry_fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "ordinary failure" >&2
exit 7
EOF
chmod +x "$non_retry_fixture"
set +e
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "non-retry-fixture" "$non_retry_fixture" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 7 "$exit_code" "non-signature failures keep their exit code"

echo ""
echo "All nix GC race retry helper tests passed"
