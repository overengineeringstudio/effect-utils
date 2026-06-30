#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

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

eval_test_module_attr() {
  local concurrency="$1"
  local attr_expr="$2"

  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
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
              { path = \"packages/native-b\"; name = \"native-b\"; after = [ \"native:link\" ]; }
              { path = \"packages/ok-c\"; name = \"ok-c\"; }
            ];
            extraTests = [ \"test:extra\" ];
            packageConcurrency = $concurrency;
          }) {
            inherit pkgs;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
      tasks = evaluated.config.tasks;
    in $attr_expr
  "
}

echo "Running test task smoke test..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

assert_eq \
  '["pnpm:install"]' \
  "$(eval_test_module_attr 2 'builtins.toJSON tasks."test:ok-a".after')" \
  "first-batch package keeps only its direct prerequisites"

assert_eq \
  '["pnpm:install","native:link"]' \
  "$(eval_test_module_attr 2 'builtins.toJSON tasks."test:native-b".after')" \
  "first-batch package keeps package-specific prerequisites"

assert_eq \
  '["pnpm:install","test:run:batch:0"]' \
  "$(eval_test_module_attr 2 'builtins.toJSON tasks."test:ok-c".after')" \
  "later-batch package waits for previous batch barrier"

assert_eq \
  '["test:ok-a","test:native-b"]' \
  "$(eval_test_module_attr 2 'builtins.toJSON tasks."test:run:batch:0".after')" \
  "first batch barrier waits for first package group"

assert_eq \
  '["test:ok-c"]' \
  "$(eval_test_module_attr 2 'builtins.toJSON tasks."test:run:batch:1".after')" \
  "second batch barrier waits for second package group"

assert_eq \
  '["test:run:batch:1","test:extra"]' \
  "$(eval_test_module_attr 2 'builtins.toJSON tasks."test:run".after')" \
  "bounded test:run waits for final package batch and extra tests"

assert_eq \
  'null' \
  "$(eval_test_module_attr 2 'builtins.toJSON tasks."test:run".exec')" \
  "bounded test:run stays a graph-only task"

set +e
eval_test_module_attr 0 'tasks."test:run".exec' >/dev/null 2>"$tmpdir/invalid.stderr"
exit_code=$?
set -e

if [ "$exit_code" -eq 0 ]; then
  echo "FAIL: invalid packageConcurrency should fail at Nix evaluation"
  exit 1
fi

if ! grep -Fq "packageConcurrency must be at least 1" "$tmpdir/invalid.stderr"; then
  echo "FAIL: invalid packageConcurrency prints a useful error"
  exit 1
fi

echo "test task smoke test passed"
