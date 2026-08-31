#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
MODULE="$ROOT/nix/devenv-modules/tasks/shared/flake-lock-duplicates.nix"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
workspace="$tmpdir/workspace"
mkdir -p "$workspace"

fail() {
  echo "FAIL: $1"
  exit 1
}

assert_status() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$actual" -ne "$expected" ]; then
    echo "FAIL: $label"
    echo "  expected status: $expected"
    echo "  actual status:   $actual"
    echo "  actual output:"
    printf '%s\n' "$output" | sed 's/^/    /'
    exit 1
  fi
}

assert_contains() {
  local output="$1"
  local expected="$2"
  local label="$3"

  if ! printf '%s\n' "$output" | grep -qF -- "$expected"; then
    echo "FAIL: $label"
    echo "  expected output to contain: $expected"
    echo "  actual output:"
    printf '%s\n' "$output" | sed 's/^/    /'
    exit 1
  fi
}

assert_equals() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $label"
    echo "  expected:"
    printf '%s\n' "$expected" | sed 's/^/    /'
    echo "  actual:"
    printf '%s\n' "$actual" | sed 's/^/    /'
    exit 1
  fi
}

write_lock() {
  local path="$1"
  local nodes="$2"

  mkdir -p "$(dirname "$path")"
  cat > "$path" <<JSON
{
  "nodes": $nodes,
  "root": "root",
  "version": 7
}
JSON
}

build_task_script() {
  local lockfiles_json
  lockfiles_json="$(printf '%s\n' "$@" | jq -Rsc 'split("\n")[:-1]')"

  LOCKFILES_JSON="$lockfiles_json" nix-build --no-out-link --impure --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (import $MODULE {
        lockfiles = builtins.fromJSON (builtins.getEnv \"LOCKFILES_JSON\");
      }) {
        inherit pkgs;
        lib = pkgs.lib;
      };
    in pkgs.writeShellScript \"flake-lock-duplicates-test-task\"
      module.tasks.\"nix:flake-lock:check-duplicates\".exec
  "
}

run_check() {
  local task_script
  task_script="$(build_task_script "$@")"
  [ -x "$task_script" ] || fail "Nix did not build the generated task script"

  set +e
  output="$(
    cd "$workspace"
    OTELITE_HTTP_ENDPOINT= \
      OTEL_EXPORTER_OTLP_ENDPOINT= \
      OTEL_SPAN_SPOOL_DIR= \
      "$task_script" 2>&1
  )"
  status=$?
  set -e
}

clean_nodes='{
  "root": { "inputs": { "one": "one", "two": "two" } },
  "one": { "locked": { "type": "github", "owner": "example", "repo": "one", "rev": "111", "narHash": "sha256-one" } },
  "two": { "locked": { "type": "github", "owner": "example", "repo": "two", "rev": "222", "narHash": "sha256-two" } }
}'
duplicate_nodes='{
  "root": { "inputs": { "beta": "beta", "alpha": "alpha" } },
  "beta": { "locked": { "rev": "same", "repo": "shared", "owner": "example", "type": "github", "narHash": "sha256-same" } },
  "alpha": { "locked": { "type": "github", "owner": "example", "repo": "shared", "rev": "same", "narHash": "sha256-same" } }
}'
similar_nodes='{
  "root": { "inputs": { "one": "one", "two": "two" } },
  "one": { "locked": { "type": "github", "owner": "example", "repo": "shared", "rev": "same", "narHash": "sha256-one" } },
  "two": { "locked": { "type": "github", "owner": "example", "repo": "shared", "rev": "same", "narHash": "sha256-two" } }
}'
multiple_groups_nodes='{
  "zeta": { "locked": { "type": "github", "owner": "example", "repo": "z", "rev": "z", "narHash": "sha256-z" } },
  "gamma": { "locked": { "type": "github", "owner": "example", "repo": "g", "rev": "g", "narHash": "sha256-g" } },
  "root": { "inputs": {} },
  "delta": { "locked": { "narHash": "sha256-g", "rev": "g", "repo": "g", "owner": "example", "type": "github" } },
  "alpha": { "locked": { "narHash": "sha256-z", "rev": "z", "repo": "z", "owner": "example", "type": "github" } }
}'

echo "Test 1: clean lockfile passes"
write_lock "$workspace/clean.lock" "$clean_nodes"
run_check clean.lock
assert_status 0 "$status" "clean lockfile"
assert_contains "$output" "No exact duplicate flake lock nodes found." "clean success diagnostic"

echo "Test 2: exact duplicate complete locked objects fail"
write_lock "$workspace/duplicate.lock" "$duplicate_nodes"
run_check duplicate.lock
assert_status 1 "$status" "exact duplicate"
assert_contains "$output" "duplicate.lock: exact duplicate locked identity in nodes: alpha, beta" "duplicate diagnostic"

echo "Test 3: similar but different complete identities pass"
write_lock "$workspace/similar.lock" "$similar_nodes"
run_check similar.lock
assert_status 0 "$status" "similar identities"

echo "Test 4: multiple duplicate groups across files are aggregated"
write_lock "$workspace/one.lock" "$duplicate_nodes"
write_lock "$workspace/two.lock" "$multiple_groups_nodes"
run_check two.lock one.lock
assert_status 1 "$status" "multiple duplicates"
assert_contains "$output" "one.lock: exact duplicate locked identity in nodes: alpha, beta" "first lockfile duplicate"
assert_contains "$output" "two.lock: exact duplicate locked identity in nodes: alpha, zeta" "first group in second lockfile"
assert_contains "$output" "two.lock: exact duplicate locked identity in nodes: delta, gamma" "second group in second lockfile"


echo "Test 5: missing lockfile fails without hiding other files"
rm -f "$workspace/missing.lock"
run_check duplicate.lock missing.lock
assert_status 1 "$status" "missing lockfile"
assert_contains "$output" "duplicate.lock: exact duplicate locked identity in nodes: alpha, beta" "duplicate remains visible with missing file"
assert_contains "$output" "missing.lock: missing or not a regular file" "missing file diagnostic"

echo "Test 6: malformed lockfile fails without hiding other files"
printf '{ malformed\n' > "$workspace/malformed.lock"
run_check malformed.lock duplicate.lock
assert_status 1 "$status" "malformed lockfile"
assert_contains "$output" "duplicate.lock: exact duplicate locked identity in nodes: alpha, beta" "duplicate remains visible with malformed file"
assert_contains "$output" "malformed.lock: invalid flake lock file" "malformed file diagnostic"

echo "Test 7: diagnostics have deterministic lexical ordering"
write_lock "$workspace/z.lock" "$duplicate_nodes"
write_lock "$workspace/a.lock" "$multiple_groups_nodes"
run_check z.lock a.lock
assert_status 1 "$status" "deterministic ordering"
assert_equals "a.lock: exact duplicate locked identity in nodes: alpha, zeta
a.lock: exact duplicate locked identity in nodes: delta, gamma
z.lock: exact duplicate locked identity in nodes: alpha, beta" "$output" "sorted diagnostics"

echo "Test 8: flake exports the parameterized module"
exported="$(nix-instantiate --eval --strict --json --expr "
  let flake = builtins.getFlake (toString $ROOT);
  in builtins.hasAttr \"flake-lock-duplicates\" flake.devenvModules.tasks
" | jq -r .)"
assert_equals "true" "$exported" "flake module export"

echo "flake lock duplicate task module tests passed"
