#!/usr/bin/env bash
# Exercise the actual Nix-generated guard under the caller's real Bash.
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
BASH_BIN="${BASH_BIN:-$(command -v bash)}"
TIMEOUT_BIN="$(command -v timeout)"
base_path="$PATH"
mkdir -p "$ROOT/tmp/cli-guard"
tmpdir="$(mktemp -d "$ROOT/tmp/cli-guard/fixture.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT
export NIX_FLAKE_REF="${NIX_FLAKE_REF:-git+file://$ROOT}"
export CLI_GUARD_SOURCE_ROOT="$ROOT"

render_guard() {
  local destination="$1"
  nix eval --impure --raw --expr '
    let
      flake = builtins.getFlake (builtins.getEnv "NIX_FLAKE_REF");
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      guard = import (builtins.toPath ((builtins.getEnv "CLI_GUARD_SOURCE_ROOT") + "/nix/devenv-modules/tasks/lib/cli-guard.nix")) { inherit pkgs; };
      real = builtins.getEnv "CLI_GUARD_TEST_REAL_BIN";
    in (guard.mkCliGuard {
      cli = "guard-fixture";
      tasks = [{ task = "test:fixture"; description = "Fixture task"; }];
      realBin = if real == "" then null else real;
    }).text
  ' > "$destination"
  chmod +x "$destination"
}

mkdir -p "$tmpdir/guard space" "$tmpdir/first real space" "$tmpdir/second" "$tmpdir/recursive" "$tmpdir/nonexec" "$tmpdir/cwd"
wrapper="$tmpdir/guard space/guard-fixture"
export CLI_GUARD_TEST_REAL_BIN=""
render_guard "$wrapper"
for entry in 'first real space:first' 'second:second' 'cwd:cwd'; do
  directory="${entry%:*}"
  result="${entry##*:}"
  {
    printf '#!%s\n' "$BASH_BIN"
    printf 'printf "%%s\\n" %s "$@"\n' "$result"
  } > "$tmpdir/$directory/guard-fixture"
  chmod +x "$tmpdir/$directory/guard-fixture"
done
cp "$wrapper" "$tmpdir/recursive/guard-fixture"
printf 'not executable\n' > "$tmpdir/nonexec/guard-fixture"
ln -s "$tmpdir/guard space" "$tmpdir/guard-alias"

assert_run() {
  local label="$1" expected_status="$2" expected_output="$3" path="$4" script="$5"
  shift 5
  local output status
  set +e
  output=$(DEVENV_TASK_PASSTHROUGH="${TEST_PASSTHROUGH:-1}" PATH="$path" "$TIMEOUT_BIN" 5 "$BASH_BIN" "$script" "$@" 2>"$tmpdir/stderr")
  status=$?
  set -e
  if [ "$status" != "$expected_status" ] || [ "$output" != "$expected_output" ]; then
    printf 'FAIL: %s (exit %s, expected %s)\n' "$label" "$status" "$expected_status" >&2
    cat "$tmpdir/stderr" >&2
    exit 1
  fi
  printf '  ok: %s\n' "$label"
}

printf 'Testing CLI guard with %s\n' "$BASH_BIN"
TEST_PASSTHROUGH=0
assert_run 'direct invocation retains task policy' 1 '' "$base_path" "$wrapper"
grep -Fq 'devenv tasks run test:fixture' "$tmpdir/stderr"
unset TEST_PASSTHROUGH

assert_run 'search order, spaces and literal arguments' 0 $'first\narg with spaces\n\n*\n$HOME' "$tmpdir/guard space:$tmpdir/first real space:$tmpdir/second:$base_path" "$wrapper" 'arg with spaces' '' '*' '$HOME'
assert_run 'reversed search order remains authoritative' 0 second "$tmpdir/guard space:$tmpdir/second:$tmpdir/first real space:$base_path" "$wrapper"
(
  cd "$tmpdir/cwd"
  assert_run 'empty PATH entries are skipped, not interpreted as cwd' 0 first ":$tmpdir/guard space:::$tmpdir/first real space:$base_path:" "$wrapper"
  assert_run 'explicit current-directory entry remains supported' 0 cwd "$tmpdir/guard space:.:$tmpdir/first real space:$base_path" "$wrapper"
)
assert_run 'physical self-directory alias is skipped' 0 first "$tmpdir/guard-alias:$tmpdir/first real space:$base_path" "$wrapper"
assert_run 'recursive guard marker is skipped' 0 first "$tmpdir/recursive:$tmpdir/first real space:$base_path" "$wrapper"
assert_run 'nonexistent and nonexecutable candidates are skipped' 0 first "$tmpdir/missing:$tmpdir/nonexec:$tmpdir/first real space:$base_path" "$wrapper"
assert_run 'missing real command retains exit 127' 127 '' "$tmpdir/guard space:$base_path" "$wrapper"
grep -Fq "not found on PATH (after removing guard)" "$tmpdir/stderr"

for size in 1024 4000 40000; do
  padding=$(printf '%0*d' "$size" 0)
  assert_run "long PATH ($size-byte component) completes within deadline" 0 first "$tmpdir/guard space:/nonexistent/$padding:$tmpdir/first real space:$base_path" "$wrapper"
done

export CLI_GUARD_TEST_REAL_BIN="$tmpdir/first real space/guard-fixture"
render_guard "$tmpdir/absolute-guard"
assert_run 'known realBin still bypasses PATH lookup by absolute path' 0 first "$tmpdir/second:$base_path" "$tmpdir/absolute-guard"
printf 'CLI guard tests passed.\n'
