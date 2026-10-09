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

# Weighted fixture: two long source tasks, one medium task, three default-weight
# tasks. `closureOf` follows `after` edges the way the devenv runner schedules a
# requested task; `dependentsOf` is every task a failure would skip.
weighted='packageWeights = { "test:long-d" = 72; "test:long-e" = 65; "test:ok-a" = 10; };'

eval_test_module_attr() {
  local concurrency="$1"
  local attr_expr="$2"
  local extra_args="${3:-}"

  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      lib = pkgs.lib;
      evaluated = lib.evalModules {
        specialArgs = { inherit pkgs; };
        modules = [
          ({ ... }: {
            options.tasks = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
            options.processes = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
            options.packages = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
            config.tasks.\"test:ok-c\".exec = lib.mkForce \"overridden-package-runtime\";
            config.tasks.\"test:ok-c\".env.RUNTIME_TOOL = \"pinned-tool\";
            config.tasks.\"test:ok-c\".status = \"package-status-check\";
          })
          (import $ROOT/nix/devenv-modules/tasks/shared/test.nix {
            packages = [
              { path = \"packages/ok-a\"; name = \"ok-a\"; }
              { path = \"packages/native-b\"; name = \"native-b\"; after = [ \"native:link\" ]; }
              { path = \"packages/ok-c\"; name = \"ok-c\"; installTask = \"install:ok-c\"; }
              { path = \"packages/long-d\"; name = \"long-d\"; }
              { path = \"packages/long-e\"; name = \"long-e\"; }
              { path = \"packages/small-f\"; name = \"small-f\"; }
            ];
            extraTests = [ \"test:extra\" ];
            packageConcurrency = $concurrency;
            $extra_args
          })
        ];
      };
      tasks = evaluated.config.tasks;
      closureOf = root:
        let
          go = seen: todo:
            if todo == [ ] then seen
            else
              let
                head = builtins.head todo;
                rest = builtins.tail todo;
              in
              if builtins.elem head seen then go seen rest
              else go (seen ++ [ head ]) (rest ++ (if builtins.hasAttr head tasks then (builtins.getAttr head tasks).after or [ ] else [ ]));
        in
        lib.sort (a: b: a < b) (go [ ] [ root ]);
      dependentsOf = failed:
        builtins.filter (name: name != failed && builtins.elem failed (closureOf name)) (builtins.attrNames tasks);
      chainAliases = builtins.filter (lib.hasPrefix \"test:run:chain:\") (builtins.attrNames tasks);
    in $attr_expr
  "
}

echo "Running test task smoke test..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# --- Standalone package tasks are unchanged by aggregate scheduling ---

assert_eq \
  '["pnpm:install"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:ok-a".after' "$weighted")" \
  "standalone package keeps only its direct prerequisites"

assert_eq \
  '["pnpm:install","native:link"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:native-b".after' "$weighted")" \
  "standalone package keeps package-specific prerequisites"

assert_eq \
  '["install:ok-c","test:ok-c"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON (closureOf "test:ok-c")' "$weighted")" \
  "direct package execution keeps its scoped installer and drags in no chain"

assert_eq \
  'packages/ok-c' \
  "$(eval_test_module_attr 4 'tasks."test:ok-c".cwd' "$weighted")" \
  "standalone package keeps its package cwd"

# --- Weighted four-chain assignment (cap 4) ---

assert_eq \
  '["test:run:chain:0:long-d","test:run:chain:1:long-e","test:run:chain:2:ok-a","test:run:chain:3:native-b","test:run:chain:3:ok-c","test:run:chain:3:small-f"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON chainAliases' "$weighted")" \
  "longest-first assignment puts each long task in its own chain and stays within four chains"

assert_eq \
  '["test:run:chain:0:long-d","test:run:chain:1:long-e","test:run:chain:2:ok-a","test:run:chain:3:small-f","test:extra"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:run".after' "$weighted")" \
  "test:run waits for every chain tail and every extra test"

assert_eq \
  'null' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:run".exec' "$weighted")" \
  "bounded test:run stays a graph-only task"

assert_eq \
  '[]' \
  "$(eval_test_module_attr 4 'builtins.toJSON (builtins.filter (lib.hasPrefix "test:run:batch") (builtins.attrNames tasks))' "$weighted")" \
  "obsolete whole-batch barriers are gone"

assert_eq \
  '["pnpm:install","native:link"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:run:chain:3:native-b".after' "$weighted")" \
  "chain head preserves package-specific prerequisites"

assert_eq \
  '["pnpm:install","test:run:chain:3:native-b"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:run:chain:3:ok-c".after' "$weighted")" \
  "chain alias uses the shared installer and only its own chain predecessor"

# A short chain advances independently: its tail never depends on long chains.
assert_eq \
  '["native:link","pnpm:install","test:run:chain:3:native-b","test:run:chain:3:ok-c","test:run:chain:3:small-f"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON (closureOf "test:run:chain:3:small-f")' "$weighted")" \
  "completed short chain advances without waiting for the slow chains"

# Failure isolation: a failing long task skips only test:run, no other chain.
assert_eq \
  '["test:run"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON (dependentsOf "test:run:chain:0:long-d")' "$weighted")" \
  "failing task does not drop unrelated chains"

assert_eq \
  'true' \
  "$(eval_test_module_attr 4 'builtins.toJSON (lib.all (name: builtins.elem name (closureOf "test:run")) (chainAliases ++ [ "test:extra" ]))' "$weighted")" \
  "every chain alias and extra test stays in the aggregate closure"

# --- Execution aliases reuse the final package task identity ---

assert_eq \
  'overridden-package-runtime' \
  "$(eval_test_module_attr 4 'tasks."test:run:chain:3:ok-c".exec' "$weighted")" \
  "chain aliases reuse the final package runtime override"

assert_eq \
  'pinned-tool' \
  "$(eval_test_module_attr 4 'tasks."test:run:chain:3:ok-c".env.RUNTIME_TOOL' "$weighted")" \
  "chain aliases reuse the final package tool environment"

assert_eq \
  'true' \
  "$(eval_test_module_attr 4 'builtins.toJSON (lib.all (attr: (builtins.getAttr attr tasks."test:run:chain:3:ok-c") == (builtins.getAttr attr tasks."test:ok-c")) [ "description" "cwd" "status" "execIfModified" ])' "$weighted")" \
  "chain aliases reuse final description, cwd, status, and execIfModified"

# --- Three-chain fallback ---

assert_eq \
  '["test:run:chain:0:long-d","test:run:chain:1:long-e","test:run:chain:2:small-f","test:extra"]' \
  "$(eval_test_module_attr 3 'builtins.toJSON tasks."test:run".after' "$weighted")" \
  "three-chain fallback keeps long tasks separate and waits for each tail"

assert_eq \
  '["pnpm:install","test:run:chain:2:native-b"]' \
  "$(eval_test_module_attr 3 'builtins.toJSON tasks."test:run:chain:2:ok-c".after' "$weighted")" \
  "three-chain fallback orders short tasks within the least-loaded chain"

# --- Unspecified weights default to 1 with lexical tie-breaking ---

assert_eq \
  '["test:run:chain:0:long-d","test:run:chain:0:ok-c","test:run:chain:1:long-e","test:run:chain:1:small-f","test:run:chain:2:native-b","test:run:chain:3:ok-a"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON chainAliases')" \
  "unspecified weights default to 1 and assign deterministically"

assert_eq \
  '["test:run:chain:0:ok-c","test:run:chain:1:small-f","test:run:chain:2:native-b","test:run:chain:3:ok-a","test:extra"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:run".after')" \
  "unweighted test:run waits for every chain tail"

assert_eq \
  '["test:run","test:run:chain:0:ok-c"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON (dependentsOf "test:run:chain:0:long-d")')" \
  "failure skips only its own chain successors and the aggregate"

# --- Aggregate scope ---

assert_eq \
  '["test:run:chain:0:native-b"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON chainAliases' \
    'aggregatePackages = [ { path = "packages/native-b"; name = "native-b"; after = [ "native:link" ]; } ];')" \
  "platform aggregate schedules only its selected source packages"

assert_eq \
  '["install:ok-c"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:ok-c".after' \
    'aggregatePackages = [ { path = "packages/native-b"; name = "native-b"; } ];')" \
  "platform aggregate preserves unselected standalone tasks and their installers"

assert_eq \
  '["test:extra"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:run".after' 'aggregatePackages = [ ];')" \
  "empty source scope retains extra suites without a nonexistent chain"

assert_eq \
  '["test:ok-a","test:native-b","test:ok-c","test:long-d","test:long-e","test:small-f","test:extra"]' \
  "$(eval_test_module_attr null 'builtins.toJSON tasks."test:run".after')" \
  "unbounded test:run still depends directly on every package task"

# --- Invalid inputs fail at evaluation with useful errors ---

assert_eval_fails() {
  local concurrency="$1"
  local extra_args="$2"
  local message="$3"
  local label="$4"
  local exit_code

  set +e
  eval_test_module_attr "$concurrency" 'builtins.toJSON tasks."test:run".after' "$extra_args" >/dev/null 2>"$tmpdir/invalid.stderr"
  exit_code=$?
  set -e

  if [ "$exit_code" -eq 0 ]; then
    echo "FAIL: $label should fail at Nix evaluation"
    exit 1
  fi
  if ! grep -Fq "$message" "$tmpdir/invalid.stderr"; then
    echo "FAIL: $label prints a useful error"
    cat "$tmpdir/invalid.stderr"
    exit 1
  fi
}

assert_eval_fails 0 '' "packageConcurrency must be a positive integer or null" "zero packageConcurrency"
assert_eval_fails '"4"' '' "packageConcurrency must be a positive integer or null" "non-integer packageConcurrency"
assert_eval_fails 4 'packageWeights = { "test:ok-a" = 0; };' 'packageWeights.test:ok-a must be a positive integer number of seconds' "zero package weight"
assert_eval_fails 4 'packageWeights = { "test:ok-a" = 1.5; };' 'packageWeights.test:ok-a must be a positive integer number of seconds' "fractional package weight"
assert_eval_fails 4 'packageWeights = [ ];' "packageWeights must be an attribute set of positive integer seconds" "non-attrset packageWeights"

echo "test task smoke test passed"
