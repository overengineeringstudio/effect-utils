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

extract_task_script() {
  local workspace_root="$1"
  local attr="$2"
  local output_path="$3"

  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      pkgsForTest = pkgs // {
        # The smoke test extracts task shell code directly via nix eval instead
        # of running a full derivation. Using toFile keeps helper scripts
        # addressable immediately, whereas pkgs.writeText would point at a store
        # path that is only realized when a derivation builds.
        writeText = name: text: builtins.toFile name text;
      };
      module = (import $ROOT/nix/devenv-modules/tasks/shared/pnpm.nix { packages = [ ]; }) {
        pkgs = pkgsForTest;
        lib = pkgs.lib;
        config = { devenv.root = \"$workspace_root\"; };
      };
    in module.tasks.\"pnpm:install\".${attr}
  " > "$output_path"
  chmod +x "$output_path"
}

extract_shared_task_script() {
  local module_path="$1"
  local task_name="$2"
  local package_path="$3"
  local package_name="$4"
  local output_path="$5"

  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      pkgsForTest = pkgs // {
        writeText = name: text: builtins.toFile name text;
      };
      lib = pkgs.lib;
      evaluated = lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
            options.processes = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
            options.packages = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/${module_path} {
            packages = [
              {
                path = \"$package_path\";
                name = \"$package_name\";
                port = 6006;
              }
            ];
          }) {
            pkgs = pkgsForTest;
            lib = lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"${task_name}\".exec
  " > "$output_path"
  chmod +x "$output_path"
}

rewrite_unrealized_tool_paths() {
  local script_path="$1"

  # The smoke test evaluates the task shell text directly instead of building
  # the referenced helper packages. Patch the generated absolute store paths to
  # temp-local shims so the test only exercises task behavior, not derivation
  # realisation.
  perl -0pi -e 's#/nix/store/[^"\s]*/bin/flock#'"$tmpdir"'/bin/flock#g; s#/nix/store/[^"\s]*/bin/node#node#g' "$script_path"
}

echo "Running pnpm task smoke test..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

workspace="$tmpdir/workspace"
mkdir -p "$workspace/.direnv/task-cache" "$workspace/.pnpm-home-a/store/v11" "$workspace/.pnpm-home-b/store/v11" "$tmpdir/bin" "$workspace/packages/demo/node_modules/.bin"

cat > "$workspace/package.json" <<'EOF'
{"name":"smoke-workspace","private":true}
EOF
cat > "$workspace/pnpm-workspace.yaml" <<'EOF'
packages: []
EOF
cat > "$workspace/pnpm-lock.yaml" <<'EOF'
lockfileVersion: '9.0'
settings: {}
importers: {}
packages: {}
EOF
cat > "$workspace/packages/demo/package.json" <<'EOF'
{"name":"demo","private":true}
EOF

cat > "$tmpdir/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TEST_PNPM_LOG:?}"
if [ "${1:-}" = "--version" ]; then
  if [ "${TEST_PNPM_VERSION_READS_STDIN:-0}" = "1" ]; then
    cat >/dev/null
  fi
  echo "11.0.0-beta.2"
  exit 0
fi
if [ "${1:-}" = "install" ]; then
  mkdir -p node_modules
  touch node_modules/.install-ok
  # The warm-path status now fingerprints the root projection metadata that
  # pnpm always writes on a real install. Keep the smoke fixture aligned with
  # that contract so the test still exercises the task logic instead of
  # failing on an unrealistically incomplete fake install.
  cat > node_modules/.modules.yaml <<'YAML'
hoistPattern: []
nodeLinker: isolated
storeDir: /tmp/fake-pnpm-store
virtualStoreDir: node_modules/.pnpm
YAML
  exit 0
fi
echo "unexpected fake pnpm invocation: $*" >&2
exit 1
EOF
chmod +x "$tmpdir/bin/pnpm"

cat > "$tmpdir/bin/flock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# The smoke test is single-process, so it only needs a no-op lock command to
# keep the generated task script moving through its install path.
exit 0
EOF
chmod +x "$tmpdir/bin/flock"

mkdir -p "$workspace/packages/demo/node_modules/vitest/bin" "$workspace/packages/demo/node_modules/storybook/bin"
cat > "$workspace/packages/demo/node_modules/vitest/package.json" <<'EOF'
{"name":"vitest","bin":{"vitest":"bin/vitest.js"}}
EOF
cat > "$workspace/packages/demo/node_modules/vitest/bin/vitest.js" <<'EOF'
#!/usr/bin/env node
console.log(`vitest:${process.argv.slice(2).join(' ')}`)
EOF
chmod +x "$workspace/packages/demo/node_modules/vitest/bin/vitest.js"
cat > "$workspace/packages/demo/node_modules/.bin/vitest" <<'EOF'
#!/usr/bin/env bash
printf 'vitest-shim:%s\n' "$*"
EOF
chmod +x "$workspace/packages/demo/node_modules/.bin/vitest"
cat > "$workspace/packages/demo/node_modules/storybook/package.json" <<'EOF'
{"name":"storybook","bin":{"storybook":"bin/storybook.js"}}
EOF
cat > "$workspace/packages/demo/node_modules/storybook/bin/storybook.js" <<'EOF'
#!/usr/bin/env node
console.log(`storybook:${process.argv.slice(2).join(' ')}`)
EOF
chmod +x "$workspace/packages/demo/node_modules/storybook/bin/storybook.js"
cat > "$workspace/packages/demo/node_modules/.bin/storybook" <<'EOF'
#!/usr/bin/env bash
printf 'storybook-shim:%s\n' "$*"
EOF
chmod +x "$workspace/packages/demo/node_modules/.bin/storybook"

extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install.exec.sh"
extract_task_script "$workspace" "status" "$tmpdir/pnpm-install.status.sh"
extract_shared_task_script \
  "nix/devenv-modules/tasks/shared/test.nix" \
  "test:demo" \
  "packages/demo" \
  "demo" \
  "$tmpdir/test-demo.exec.sh"
extract_shared_task_script \
  "nix/devenv-modules/tasks/shared/storybook.nix" \
  "storybook:build:demo" \
  "packages/demo" \
  "demo" \
  "$tmpdir/storybook-demo.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install.exec.sh"
rewrite_unrealized_tool_paths "$tmpdir/pnpm-install.status.sh"

export PATH="$tmpdir/bin:$PATH"
export TEST_PNPM_LOG="$tmpdir/pnpm.log"

echo "Test 1: status misses before install"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "status should miss before install"
)

echo "Test 2: exec runs fake pnpm and populates cache"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  bash "$tmpdir/pnpm-install.exec.sh"
  test -f "$workspace/.direnv/task-cache/pnpm-install/install-state.hash"
  test -f "$workspace/.direnv/task-cache/pnpm-install/projection-state.hash"
  test -d "$workspace/node_modules"
  test -f "$workspace/node_modules/.modules.yaml"
)

echo "Test 3: status hits after install with same GVS path"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 0 "$exit_code" "status should hit after install"
)

echo "Test 4: outer cache hit still misses when projection metadata is missing"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  export DEVENV_SETUP_OUTER_CACHE_HIT=1
  rm -f node_modules/.modules.yaml
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "outer-hit status should miss when .modules.yaml is missing"
)

echo "Test 5: exec restores projection metadata after a miss"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  bash "$tmpdir/pnpm-install.exec.sh"
  test -f "$workspace/node_modules/.modules.yaml"
)

echo "Test 6: status misses after effective GVS path changes"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-b"
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "status should miss when GVS path changes"
)

echo "Test 7: exec invoked pnpm version and install"
grep -qxF -- "--version" "$tmpdir/pnpm.log"
grep -q "^install " "$tmpdir/pnpm.log"

echo "Test 6: exec detaches stdin before probing pnpm version"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-a"
  export TEST_PNPM_VERSION_READS_STDIN=1
  : > "$tmpdir/pnpm.log"
  mkfifo "$tmpdir/open-stdin"
  sleep 30 > "$tmpdir/open-stdin" &
  producer_pid=$!
  set +e
  timeout 3s bash "$tmpdir/pnpm-install.exec.sh" < "$tmpdir/open-stdin"
  exit_code=$?
  set -e
  kill "$producer_pid" 2>/dev/null || true
  wait "$producer_pid" 2>/dev/null || true
  assert_exit_code 0 "$exit_code" "exec should not inherit an open stdin pipe"
)
grep -qxF -- "--version" "$tmpdir/pnpm.log"

echo "Test 7: generated test task runs vitest without pnpm exec"
(
  cd "$workspace/packages/demo"
  output="$(bash "$tmpdir/test-demo.exec.sh")"
  [ "$output" = "vitest-shim:run" ]
)

echo "Test 8: generated storybook task runs storybook without pnpm exec"
(
  cd "$workspace/packages/demo"
  output="$(bash "$tmpdir/storybook-demo.exec.sh")"
  [ "$output" = "storybook-shim:build" ]
)

echo ""
echo "pnpm task smoke test passed"
