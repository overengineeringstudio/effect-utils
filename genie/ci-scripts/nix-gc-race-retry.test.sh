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

assert_contains() {
  local needle="$1"
  local file="$2"
  local label="$3"

  if ! grep -Fq "$needle" "$file"; then
    echo "FAIL: $label"
    echo "  missing: $needle"
    echo "  file:    $file"
    exit 1
  fi
}

assert_not_contains() {
  local needle="$1"
  local file="$2"
  local label="$3"

  if grep -Fq "$needle" "$file"; then
    echo "FAIL: $label"
    echo "  unexpected: $needle"
    echo "  file:       $file"
    exit 1
  fi
}

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

echo "Running nix GC race retry helper tests..."
echo ""

echo "Test 1: standalone helper stays aligned with workflow helper source"
node - "$ROOT" <<'NODE'
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = process.argv[2]
const standalone = readFileSync(
  join(root, 'genie/ci-scripts/nix-gc-race-retry.sh'),
  'utf8',
)
const supportFilesSource = readFileSync(join(root, 'genie/ci-workflow/support-files.ts'), 'utf8')
const match = supportFilesSource.match(
  /export const ciWorkflowNixGcRaceRetryScript = String\.raw`([\s\S]*?)`\n\nexport const ciWorkflowNixGcRaceRetryWrapperScript/,
)

if (match === null) {
  console.error('FAIL: unable to locate ciWorkflowNixGcRaceRetryScript in support-files.ts')
  process.exit(1)
}

const embedded = match[1].replaceAll('${dollar}', '$').trimEnd()
const normalizedStandalone = standalone.replace(
  /^#!\/usr\/bin\/env bash\n# Generated file - DO NOT EDIT\n# Source: nix-gc-race-retry\.sh\.genie\.ts\n\n/,
  '#!/usr/bin/env bash\n',
).trimEnd()
if (normalizedStandalone !== embedded) {
  console.error('FAIL: standalone helper drifted from workflow helper source')
  process.exit(1)
}
NODE

echo "Test 2: retries invalid-store-path failures and succeeds on the next attempt"
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

echo "Test 3: retries cachix wrapper failures without an extracted store path"
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
  echo "error: Failed to convert config.cachix to JSON" >&2
  echo "error: while evaluating the option cachix.package" >&2
  exit 1
fi
echo "cachix recovered"
EOF
chmod +x "$cachix_fixture"
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "cachix-fixture" "$cachix_fixture" >/dev/null
assert_eq "2" "$(cat "$test_dir/cachix-attempt")" "cachix wrapper retry count"

echo "Test 4: retries truncated Nix input tarball failures"
fetch_fixture="$test_dir/fetch-fixture.sh"
cat > "$fetch_fixture" <<EOF
#!/usr/bin/env bash
set -euo pipefail
attempt_file="$test_dir/fetch-attempt"
attempt=1
if [ -f "\$attempt_file" ]; then
  attempt=\$(cat "\$attempt_file")
fi
if [ "\$attempt" -eq 1 ]; then
  echo 2 > "\$attempt_file"
  echo "error: cannot read file from tarball: Truncated tar archive detected while reading data" >&2
  exit 1
fi
echo "fetch recovered"
EOF
chmod +x "$fetch_fixture"
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "fetch-fixture" "$fetch_fixture" >/dev/null
assert_eq "2" "$(cat "$test_dir/fetch-attempt")" "truncated tarball retry count"

echo "Test 5: retries missing Nix daemon socket failures"
daemon_fixture="$test_dir/daemon-fixture.sh"
cat > "$daemon_fixture" <<EOF
#!/usr/bin/env bash
set -euo pipefail
attempt_file="$test_dir/daemon-attempt"
attempt=1
if [ -f "\$attempt_file" ]; then
  attempt=\$(cat "\$attempt_file")
fi
if [ "\$attempt" -eq 1 ]; then
  echo 2 > "\$attempt_file"
  echo "error: cannot connect to socket at '/nix/var/nix/daemon-socket/socket': No such file or directory" >&2
  exit 1
fi
echo "daemon recovered"
EOF
chmod +x "$daemon_fixture"
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 NIX_GC_RACE_SKIP_DAEMON_REPAIR=1 run_nix_gc_race_retry "daemon-fixture" "$daemon_fixture" >/dev/null
assert_eq "2" "$(cat "$test_dir/daemon-attempt")" "Nix daemon socket retry count"

echo "Test 6: does not retry when literal signature strings appear outside Nix error context"
false_positive_fixture="$test_dir/false-positive-fixture.sh"
cat > "$false_positive_fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "AssertionError: expected source to contain Failed to convert config.cachix to JSON" >&2
echo "source snippet: while evaluating the option cachix.package" >&2
echo "source snippet: cannot connect to socket at '/nix/var/nix/daemon-socket/socket'" >&2
exit 9
EOF
chmod +x "$false_positive_fixture"
set +e
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "false-positive-fixture" "$false_positive_fixture" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 9 "$exit_code" "non-error-context strings do not trigger retries"

echo "Test 7: preserves the original exit code when no retry signature is present"
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

echo "Test 8: executes argv without shell eval"
argv_fixture="$test_dir/argv-fixture.sh"
argv_output="$test_dir/argv-output"
cat > "$argv_fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" > "$2"
EOF
chmod +x "$argv_fixture"
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=1 run_nix_gc_race_retry "argv-fixture" "$argv_fixture" 'literal $HOME value' "$argv_output" >/dev/null
assert_eq 'literal $HOME value' "$(cat "$argv_output")" "argv command arguments are not shell-expanded"

echo "Test 9: preserves stdout and stderr while capturing retry signatures"
stdio_fixture="$test_dir/stdio-fixture.sh"
stdio_stdout="$test_dir/stdio-stdout"
stdio_stderr="$test_dir/stdio-stderr"
cat > "$stdio_fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "stdout-marker"
echo "stderr-marker" >&2
exit 3
EOF
chmod +x "$stdio_fixture"
set +e
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=1 run_nix_gc_race_retry "stdio-fixture" "$stdio_fixture" >"$stdio_stdout" 2>"$stdio_stderr"
exit_code=$?
set -e
assert_exit_code 3 "$exit_code" "stdio fixture keeps original exit code"
assert_contains "stdout-marker" "$stdio_stdout" "stdout marker remains on stdout"
assert_contains "stderr-marker" "$stdio_stderr" "stderr marker remains on stderr"
assert_not_contains "stderr-marker" "$stdio_stdout" "stderr marker does not move to stdout"

echo "Test 10: wrapper script delegates shell commands to the retry helper"
wrapper_attempt_file="$test_dir/wrapper-attempt"
wrapper_command=$(cat <<EOF
attempt=1
if [ -f "$wrapper_attempt_file" ]; then
  attempt=\$(cat "$wrapper_attempt_file")
fi
if [ "\$attempt" -eq 1 ]; then
  echo 2 > "$wrapper_attempt_file"
  echo "error: path '/nix/store/wrapper-fixture-path' is not valid" >&2
  exit 1
fi
echo "wrapper recovered"
EOF
)
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 "$ROOT/genie/ci-scripts/run-with-nix-gc-race-retry.sh" "wrapper-fixture" "$wrapper_command" >/dev/null
assert_eq "2" "$(cat "$wrapper_attempt_file")" "wrapper retry count"

echo ""
echo "All nix GC race retry helper tests passed"
