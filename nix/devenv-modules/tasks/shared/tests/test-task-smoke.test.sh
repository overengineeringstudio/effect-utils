#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

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

extract_test_run_script() {
  local concurrency="$1"
  local output_path="$2"

  if ! nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      pkgsForTest = pkgs // {
        writeText = name: text: builtins.toFile name text;
      };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/test.nix {
            packages = [
              { path = \"packages/ok-a\"; name = \"ok-a\"; }
              { path = \"packages/fail-b\"; name = \"fail-b\"; }
              { path = \"packages/ok-c\"; name = \"ok-c\"; }
            ];
            packageConcurrency = $concurrency;
          }) {
            pkgs = pkgsForTest;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"test:run\".exec
  " > "$output_path"; then
    return 1
  fi
  chmod +x "$output_path"
}

echo "Running test task smoke test..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

mkdir -p "$tmpdir/bin"

cat > "$tmpdir/bin/devenv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

lock_dir="${TEST_LOCK_DIR:?}"
active_file="${TEST_ACTIVE_FILE:?}"
max_file="${TEST_MAX_FILE:?}"
log_file="${TEST_LOG_FILE:?}"

if [ "$#" -ne 5 ] || [ "$1" != "tasks" ] || [ "$2" != "run" ] || [ "$3" != "--mode" ] || [ "$4" != "single" ]; then
  printf 'unexpected devenv argv: %s\n' "$*" >&2
  exit 64
fi

task="$5"

lock() {
  while ! mkdir "$lock_dir" 2>/dev/null; do
    sleep 0.01
  done
}

unlock() {
  rmdir "$lock_dir"
}

lock
active="$(cat "$active_file")"
active=$((active + 1))
printf '%s' "$active" > "$active_file"
max_active="$(cat "$max_file")"
if [ "$active" -gt "$max_active" ]; then
  printf '%s' "$active" > "$max_file"
fi
printf 'start %s\n' "$task" >> "$log_file"
unlock

case "$task" in
  test:fail-b)
    sleep 0.05
    rc=7
    ;;
  *)
    sleep 0.2
    rc=0
    ;;
esac

lock
active="$(cat "$active_file")"
active=$((active - 1))
printf '%s' "$active" > "$active_file"
printf 'end %s %s\n' "$task" "$rc" >> "$log_file"
unlock

exit "$rc"
EOF
chmod +x "$tmpdir/bin/devenv"

script="$tmpdir/test-run.sh"
extract_test_run_script 2 "$script"

printf '0' > "$tmpdir/active"
printf '0' > "$tmpdir/max-active"
: > "$tmpdir/devenv.log"

set +e
PATH="$tmpdir/bin:$PATH" \
TEST_LOCK_DIR="$tmpdir/lock" \
TEST_ACTIVE_FILE="$tmpdir/active" \
TEST_MAX_FILE="$tmpdir/max-active" \
TEST_LOG_FILE="$tmpdir/devenv.log" \
  "$script"
exit_code=$?
set -e

assert_exit_code 1 "$exit_code" "bounded test:run reports package task failures"
assert_eq 2 "$(cat "$tmpdir/max-active")" "bounded test:run respects packageConcurrency"
assert_eq 3 "$(grep -c '^start test:' "$tmpdir/devenv.log")" "bounded test:run still launches all package tasks"

set +e
extract_test_run_script 0 "$tmpdir/test-run-invalid.sh" >"$tmpdir/invalid.stdout" 2>"$tmpdir/invalid.stderr"
exit_code=$?
set -e

assert_exit_code 1 "$exit_code" "invalid packageConcurrency fails at Nix evaluation"
if ! grep -Fq "packageConcurrency must be at least 1" "$tmpdir/invalid.stderr"; then
  echo "FAIL: invalid packageConcurrency prints a useful error"
  exit 1
fi

echo "test task smoke test passed"
