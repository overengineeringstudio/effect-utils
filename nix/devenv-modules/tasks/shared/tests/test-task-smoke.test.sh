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
            config.tasks.\"install:ok-c\" = {
              description = \"Scoped installer\";
              exec = \"scoped-install-command\";
              env.INSTALL_TOOL = \"pinned-installer\";
              status = \"installer-status-check\";
              after = [ ];
            };
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
  '["test:run:install:3:ok-c","test:run:chain:3:native-b"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:run:chain:3:ok-c".after' "$weighted")" \
  "chain test retains its direct predecessor and ordered scoped installation"

assert_eq \
  '["test:run:chain:3:native-b"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:run:install:3:ok-c".after' "$weighted")" \
  "scoped installation cannot start before its chain predecessor finishes"

assert_eq \
  '["scoped-install-command","pinned-installer","installer-status-check"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON [ tasks."test:run:install:3:ok-c".exec tasks."test:run:install:3:ok-c".env.INSTALL_TOOL tasks."test:run:install:3:ok-c".status ]' "$weighted")" \
  "scoped installation reuses the final installer command, tool environment and status"

# A short chain advances independently: its tail never depends on long chains.
assert_eq \
  '["native:link","pnpm:install","test:run:chain:3:native-b","test:run:chain:3:ok-c","test:run:chain:3:small-f","test:run:install:3:ok-c"]' \
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
  '["test:run:install:2:ok-c","test:run:chain:2:native-b"]' \
  "$(eval_test_module_attr 3 'builtins.toJSON tasks."test:run:chain:2:ok-c".after' "$weighted")" \
  "three-chain fallback orders short tasks within the least-loaded chain"

assert_eq \
  '["test:run:chain:2:native-b"]' \
  "$(eval_test_module_attr 3 'builtins.toJSON tasks."test:run:install:2:ok-c".after' "$weighted")" \
  "three-chain fallback also orders its scoped installation"

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
  '["test:run","test:run:chain:0:ok-c","test:run:install:0:ok-c"]' \
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

# --- Explicit ordered partitions reuse the same chain and installer machinery ---

explicit='packageChains = [
  [ "test:long-d" "test:ok-c" ]
  [ "test:long-e" "test:small-f" ]
  [ "test:ok-a" ]
  [ "test:native-b" ]
];'
assert_eq \
  '["test:run:chain:0:ok-c","test:run:chain:1:small-f","test:run:chain:2:ok-a","test:run:chain:3:native-b","test:extra"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:run".after' "$weighted $explicit")" \
  "explicit partition preserves ordered tails and extra suites"
assert_eq \
  '["test:run:chain:0:long-d"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:run:install:0:ok-c".after' "$explicit")" \
  "explicit scoped installer waits for its predecessor"
assert_eq \
  '["test:run:install:0:ok-c","test:run:chain:0:long-d"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:run:chain:0:ok-c".after' "$explicit")" \
  "explicit execution retains installer and direct predecessor"
assert_eq \
  '["overridden-package-runtime","pinned-tool","package-status-check","scoped-install-command","pinned-installer","installer-status-check"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON [ tasks."test:run:chain:0:ok-c".exec tasks."test:run:chain:0:ok-c".env.RUNTIME_TOOL tasks."test:run:chain:0:ok-c".status tasks."test:run:install:0:ok-c".exec tasks."test:run:install:0:ok-c".env.INSTALL_TOOL tasks."test:run:install:0:ok-c".status ]' "$explicit")" \
  "explicit aliases reuse final execution and installer overrides"
assert_eq \
  '["test:long-d","test:long-e","test:native-b","test:ok-a","test:ok-c","test:small-f"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON (lib.sort builtins.lessThan (map (name: "test:" + lib.last (lib.splitString ":" name)) (builtins.filter (name: builtins.elem name (closureOf "test:run")) chainAliases)))' "$explicit")" \
  "explicit aggregate covers exactly the selected package union"
assert_eq \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks' "$weighted")" \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks' "$weighted packageChains = null;")" \
  "null chains preserve the entire weighted task graph byte for byte"
assert_eq \
  '["test:run:chain:0:native-b","test:extra"]' \
  "$(eval_test_module_attr 4 'builtins.toJSON tasks."test:run".after' 'aggregatePackages = [ { path = "packages/native-b"; name = "native-b"; } ]; packageChains = [ [ "test:native-b" ] [ ] [ ] [ ] ];')" \
  "explicit empty chains do not create nonexistent tails"

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
assert_eval_fails null "$explicit" "packageChains requires packageConcurrency" "chains without concurrency"
assert_eval_fails 4 'packageChains = { };' "packageChains must be a list of lists" "non-list chains"
assert_eval_fails 4 'packageChains = [ "test:ok-a" ];' "packageChains must be a list of lists" "non-list chain"
assert_eval_fails 4 'packageChains = [ [ 1 ] ];' "packageChains must be a list of lists" "non-string name"
assert_eval_fails 4 'packageChains = [ ];' "packageChains must contain exactly packageConcurrency chains" "wrong chain count"
assert_eval_fails 4 'packageChains = [ [ "test:missing" ] [ ] [ ] [ ] ];' "unknown or unselected aggregate tasks: test:missing" "unknown task"
assert_eval_fails 4 'aggregatePackages = [ ]; packageChains = [ [ "test:ok-a" ] [ ] [ ] [ ] ];' "unknown or unselected aggregate tasks: test:ok-a" "unselected standalone task"
assert_eval_fails 4 'packageChains = [ [ "test:ok-a" "test:ok-a" ] [ ] [ ] [ ] ];' "duplicate aggregate tasks: test:ok-a" "duplicate task"
assert_eval_fails 4 'packageChains = [ [ ] [ ] [ ] [ ] ];' "omits aggregate tasks:" "omitted tasks"

# Evaluate the production root source scheduler, its real scoped publishers and
# root overrides without realizing their commands. The optional baseline module
# is the pre-change test.nix, stored beside the current module for relative imports.
eval_root_test_graph() {
  local platform="$1" baseline="${2:-}"
  EFFECT_UTILS_TEST_PLATFORM="$platform" TEST_TASK_BASELINE_MODULE="$baseline" \
    nix eval --impure --json --expr "
      let
        flake = builtins.getFlake \"$NIX_FLAKE_REF\";
        pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
        lib = pkgs.lib;
        baseline = builtins.getEnv \"TEST_TASK_BASELINE_MODULE\";
        root = builtins.scopedImport {
          import = path:
            if baseline != \"\" && path == $ROOT/nix/devenv-modules/tasks/shared/test.nix
            then args: builtins.import (builtins.toPath baseline) (builtins.removeAttrs args [ \"packageChains\" ])
            else builtins.import path;
        } $ROOT/devenv.nix { inherit pkgs lib; inputs = flake.inputs; config = evaluated.config; };
        evaluated = lib.evalModules {
          specialArgs = { inherit pkgs; };
          modules = [
            ({ ... }: {
              options.tasks = lib.mkOption {
                type = lib.types.attrsOf (lib.types.submodule {
                  freeformType = lib.types.attrsOf lib.types.anything;
                  options.after = lib.mkOption { type = lib.types.listOf lib.types.str; default = []; };
                });
                default = {};
              };
              options.processes = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = {}; };
              options.packages = lib.mkOption { type = lib.types.listOf lib.types.anything; default = []; };
            })
            # Root import positions: source test module, then scoped publishers.
            (builtins.elemAt root.imports 13)
            (builtins.elemAt root.imports 15)
            { tasks = builtins.mapAttrs (_: task: { after = task.after or []; }) root.tasks; }
          ];
        };
      in builtins.mapAttrs (_: task: task.after or []) evaluated.config.tasks
    "
}

linux_graph="$(eval_root_test_graph linux)"
assert_eq "$linux_graph" "$(eval_root_test_graph '')" \
  "Linux and platform-unspecified production source graphs are identical"
if [ -n "${TEST_TASK_BASELINE_MODULE:-}" ]; then
  for platform in linux ''; do
    assert_eq "$(eval_root_test_graph "$platform" "$TEST_TASK_BASELINE_MODULE")" \
      "$(eval_root_test_graph "$platform")" \
      "production source graph is byte-identical to baseline for platform '$platform'"
  done
fi
printf 'Linux and unspecified production graph SHA-256: '
printf '%s' "$linux_graph" | sha256sum
darwin_graph="$(eval_root_test_graph darwin)"
GRAPH="$darwin_graph" SCHEDULING="$ROOT/genie/ci-workflow/test-scheduling.json" \
  "${PYTHON_BIN:-python3}" - <<'PY'
import json
import os

graph = json.loads(os.environ["GRAPH"])
with open(os.environ["SCHEDULING"]) as source:
    scheduling = json.load(source)
chains = scheduling["darwinSourceTaskChains"]
assert len(chains) == scheduling["workers"] == 4
expected = sorted(name for chain in chains for name in chain)
actual = sorted("test:" + name.split(":", 4)[4] for name in graph if name.startswith("test:run:chain:"))
assert actual == expected, (actual, expected)
for index, chain in enumerate(chains):
    previous = None
    for task in chain:
        suffix = f"{index}:{task.removeprefix('test:')}"
        execution = f"test:run:chain:{suffix}"
        installer = f"test:run:install:{suffix}"
        assert installer in graph[execution]
        if previous is not None:
            assert previous in graph[execution] and previous in graph[installer]
        previous = execution
    if previous is not None:
        assert previous in graph["test:run"]
print("production Darwin partition and installer ordering passed")
PY

echo "test task smoke test passed"
