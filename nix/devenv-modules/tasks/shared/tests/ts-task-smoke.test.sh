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

extract_ts_emit_script() {
  local attr="$1"
  local output_path="$2"

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
          ((import $ROOT/nix/devenv-modules/tasks/shared/ts.nix {
            tsconfigFile = \"tsconfig.check.json\";
            emitTsconfigFile = \"tsconfig.emit.json\";
          }) {
            pkgs = pkgs;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"ts:emit\".${attr}
  " > "$output_path"
  chmod +x "$output_path"
}

eval_ts_package_count() {
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (import $ROOT/nix/devenv-modules/tasks/shared/ts.nix {
        tsBinPkg = pkgs.writeShellScriptBin \"tsgo\" \"exit 0\";
      }) {
        pkgs = pkgs;
        lib = pkgs.lib;
        config = { };
      };
    in builtins.toString (builtins.length module.packages)
  "
}

echo "Running ts task smoke test..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

workspace="$tmpdir/workspace"
mkdir -p \
  "$workspace/packages/no-emit" \
  "$workspace/packages/emit" \
  "$workspace/packages/dotted.name" \
  "$tmpdir/bin"

cat > "$workspace/tsconfig.check.json" <<'EOF'
{
  "files": [],
  "references": [
    { "path": "packages/no-emit/tsconfig.json" },
    { "path": "packages/emit" },
    { "path": "packages/dotted.name" }
  ]
}
EOF

cat > "$workspace/packages/no-emit/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    // This comment is intentionally mid-file.
    "composite": true,
    "noEmit": true
  }
}
EOF

cat > "$workspace/packages/emit/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "composite": true,
    // Keep this project in the emit graph.
    "declaration": true
  }
}
EOF

cat > "$workspace/packages/dotted.name/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "composite": true,
    "declaration": true
  }
}
EOF

cat > "$workspace/tsconfig.emit.json" <<'EOF'
{
  "files": [],
  "references": [
    { "path": "packages/emit" },
    { "path": "packages/dotted.name" }
  ]
}
EOF

cat > "$tmpdir/bin/tsgo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TEST_TSGO_LOG:?}"

if [[ " $* " == *" --dry "* ]] && [ "${TEST_TSGO_STALE:-0}" = "1" ]; then
  echo "A non-dry build would build project 'packages/emit/tsconfig.json'"
fi

for arg in "$@"; do
  if [ "$arg" = "tsconfig.check.json" ]; then
    echo "ts:emit should not use the check graph" >&2
    exit 1
  fi
done
EOF
chmod +x "$tmpdir/bin/tsgo"

extract_ts_emit_script "exec" "$tmpdir/ts-emit.exec.sh"
extract_ts_emit_script "status" "$tmpdir/ts-emit.status.sh"

export PATH="$tmpdir/bin:$PATH"
export TEST_TSGO_LOG="$tmpdir/tsgo.log"

echo "Test 1: ts:emit exec uses tsgo with the static emit graph"
(
  cd "$workspace"
  bash "$tmpdir/ts-emit.exec.sh"
)
grep -q -- '--build tsconfig.emit.json --noCheck' "$TEST_TSGO_LOG"

echo "Preflight: tsBinPkg is exec-only guard backing, not a profile package"
assert_eq 2 "$(eval_ts_package_count)" "ts module packages should be bc plus tsgo guard only"

echo "Test 2: ts:emit status uses the static emit graph"
(
  cd "$workspace"
  : > "$TEST_TSGO_LOG"
  set +e
  bash "$tmpdir/ts-emit.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 0 "$exit_code" "ts:emit status should succeed for an already-clean emit graph"
)
grep -q -- '--build tsconfig.emit.json --dry --noCheck --verbose --pretty false' "$TEST_TSGO_LOG"

echo "Test 3: ts:emit status detects pending emit work"
(
  cd "$workspace"
  : > "$TEST_TSGO_LOG"
  set +e
  TEST_TSGO_STALE=1 bash "$tmpdir/ts-emit.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "ts:emit status should fail when dry-run reports pending work"
)

echo "Test 4: ts:emit fails when the emit graph is missing"
(
  cd "$workspace"
  : > "$TEST_TSGO_LOG"
  mv tsconfig.emit.json tsconfig.emit.json.bak

  set +e
  bash "$tmpdir/ts-emit.exec.sh" > "$tmpdir/missing-exec.out" 2> "$tmpdir/missing-exec.err"
  exec_exit_code=$?
  bash "$tmpdir/ts-emit.status.sh" > "$tmpdir/missing-status.out" 2> "$tmpdir/missing-status.err"
  status_exit_code=$?
  set -e

  assert_exit_code 1 "$exec_exit_code" "ts:emit exec should fail when the emit graph is missing"
  assert_exit_code 1 "$status_exit_code" "ts:emit status should fail when the emit graph is missing"
  grep -qF "ts:emit: emit tsconfig tsconfig.emit.json is missing or unreadable; run genie:run to generate it" "$tmpdir/missing-exec.err"
  grep -qF "ts:emit: emit tsconfig tsconfig.emit.json is missing or unreadable; run genie:run to generate it" "$tmpdir/missing-status.err"
  assert_eq "" "$(cat "$TEST_TSGO_LOG")" "ts:emit should not invoke tsgo when the emit graph is missing"

  mv tsconfig.emit.json.bak tsconfig.emit.json
)

echo "Test 5: ts:emit succeeds without invoking tsgo when the emit graph is empty"
cat > "$workspace/tsconfig.emit.json" <<'EOF'
{
  "files": [],
  "references": []
}
EOF
(
  cd "$workspace"
  : > "$TEST_TSGO_LOG"
  bash "$tmpdir/ts-emit.exec.sh" > "$tmpdir/no-work.out"
  grep -qF "ts:emit: no emit-capable referenced projects" "$tmpdir/no-work.out"
  assert_eq "" "$(cat "$TEST_TSGO_LOG")" "ts:emit exec should not invoke tsgo for an empty emit graph"

  set +e
  bash "$tmpdir/ts-emit.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 0 "$exit_code" "ts:emit status should succeed for an empty emit graph"
  assert_eq "" "$(cat "$TEST_TSGO_LOG")" "ts:emit status should not invoke tsgo for an empty emit graph"
)

echo ""
echo "ts task smoke test passed"
