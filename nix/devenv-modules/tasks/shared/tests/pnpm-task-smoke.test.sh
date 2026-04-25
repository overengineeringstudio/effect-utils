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
  local module_args="${4:-packages = [ ];}"
  local task_name="${5:-pnpm:install}"

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
      module = (import $ROOT/nix/devenv-modules/tasks/shared/pnpm.nix { ${module_args} }) {
        pkgs = pkgsForTest;
        lib = pkgs.lib;
        config = { devenv.root = \"$workspace_root\"; };
      };
    in (builtins.getAttr \"${task_name}\" module.tasks).${attr}
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
mkdir -p "$workspace/.direnv/task-cache" "$workspace/.pnpm-home-a/store/v11" "$workspace/.pnpm-home-b/store/v11" "$tmpdir/bin" "$workspace/packages/demo/node_modules/.bin" "$workspace/nested/pkg"

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
cat > "$workspace/nested/package.json" <<'EOF'
{"name":"nested-workspace","private":true}
EOF
cat > "$workspace/nested/pnpm-workspace.yaml" <<'EOF'
packages: ["pkg"]
EOF
cat > "$workspace/nested/pnpm-lock.yaml" <<'EOF'
lockfileVersion: '9.0'
settings: {}
importers: {}
packages: {}
EOF
cat > "$workspace/nested/pkg/package.json" <<'EOF'
{"name":"nested-pkg","private":true}
EOF

cat > "$tmpdir/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TEST_PNPM_LOG:?}"
printf 'PWD=%s\n' "$PWD" >> "${TEST_PNPM_LOG:?}"
if [ "${1:-}" = "--version" ]; then
  if [ "${TEST_PNPM_VERSION_READS_STDIN:-0}" = "1" ]; then
    cat >/dev/null
  fi
  echo "11.0.0-rc.5"
  exit 0
fi
if [ "${1:-}" = "install" ]; then
  printf 'PNPM_HOME=%s\n' "${PNPM_HOME:-}" >> "${TEST_PNPM_LOG:?}"
  printf 'PNPM_STORE_DIR=%s\n' "${PNPM_STORE_DIR:-}" >> "${TEST_PNPM_LOG:?}"
  printf 'npm_config_store_dir=%s\n' "${npm_config_store_dir:-}" >> "${TEST_PNPM_LOG:?}"
  if [ "${TEST_PNPM_FAIL_NETWORK:-0}" = "1" ]; then
    echo "ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/demo: request to https://registry.npmjs.org/demo failed, reason: Socket timeout" >&2
    exit 42
  fi
  mkdir -p node_modules
  touch node_modules/.install-ok
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
printf 'flock %s\n' "$*" >> "${TEST_FLOCK_LOG:?}"
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
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-nested.exec.sh" 'packages = [ "pkg" ]; workspaceRoot = "nested"; taskSuffix = "nested";' "pnpm:install:nested"
extract_task_script "$workspace" "status" "$tmpdir/pnpm-install-nested.status.sh" 'packages = [ "pkg" ]; workspaceRoot = "nested"; taskSuffix = "nested";' "pnpm:install:nested"
extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install-flags.exec.sh" 'packages = [ "." ]; installFlags = [ "--ignore-scripts" "--config.public-hoist-pattern=*" ]; preInstall = "touch .preinstall-marker";'
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
export TEST_FLOCK_LOG="$tmpdir/flock.log"
unset CI

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
  : > "$tmpdir/flock.log"
  bash "$tmpdir/pnpm-install.exec.sh"
  test -f "$workspace/.direnv/task-cache/pnpm-install/install-state.hash"
  test -d "$workspace/node_modules"
  grep -qxF "flock -w 600 200" "$tmpdir/flock.log"
  grep -qxF "flock -w 600 201" "$tmpdir/flock.log"
  grep -qxF "flock -w 600 202" "$tmpdir/flock.log"
  grep -qF ".effect-utils-pnpm-install.lock" "$tmpdir/pnpm-install.exec.sh"
  grep -qF ".effect-utils-pnpm-store.lock" "$tmpdir/pnpm-install.exec.sh"
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

echo "Test 4: exec defaults PNPM_HOME to a workspace-local projection"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  : > "$tmpdir/pnpm.log"
  bash "$tmpdir/pnpm-install.exec.sh"
  grep -qxF "PNPM_HOME=$workspace/.direnv/pnpm-home" "$tmpdir/pnpm.log"
  grep -qxF "PNPM_STORE_DIR=$workspace/.direnv/pnpm-store" "$tmpdir/pnpm.log"
  grep -qxF "npm_config_store_dir=$workspace/.direnv/pnpm-store" "$tmpdir/pnpm.log"
)

echo "Test 5: status hits after install with the default GVS path"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 0 "$exit_code" "status should hit after default-PNPM_HOME install"
)

echo "Test 6: status still hits when PNPM_HOME changes but store-dir stays shared"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_HOME="$workspace/.pnpm-home-b"
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 0 "$exit_code" "status should hit when only PNPM_HOME changes"
)

echo "Test 7: status misses after effective store-dir changes"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export PNPM_STORE_DIR="$workspace/.other-pnpm-store"
  unset npm_config_store_dir
  set +e
  bash "$tmpdir/pnpm-install.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 1 "$exit_code" "status should miss when store-dir changes"
)

echo "Test 8: exec invoked pnpm install"
grep -q "^install " "$tmpdir/pnpm.log"

echo "Test 9: nested workspace exec uses its own cwd, cache, PNPM_HOME, and shared store-dir"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  : > "$tmpdir/pnpm.log"
  bash "$tmpdir/pnpm-install-nested.exec.sh"
  test -f "$workspace/.direnv/task-cache/pnpm-install/nested/install-state.hash"
  test -d "$workspace/nested/node_modules"
  grep -qxF "PWD=$workspace/nested" "$tmpdir/pnpm.log"
  grep -qxF "PNPM_HOME=$workspace/.direnv/pnpm-home/nested" "$tmpdir/pnpm.log"
  grep -qxF "PNPM_STORE_DIR=$workspace/.direnv/pnpm-store" "$tmpdir/pnpm.log"
  grep -qxF "npm_config_store_dir=$workspace/.direnv/pnpm-store" "$tmpdir/pnpm.log"
)

echo "Test 10: nested workspace status hits after nested install"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  set +e
  bash "$tmpdir/pnpm-install-nested.status.sh"
  exit_code=$?
  set -e
  assert_exit_code 0 "$exit_code" "nested status should hit after nested install"
)

echo "Test 11: install flags and pre-install hooks are applied"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  rm -f .preinstall-marker
  : > "$tmpdir/pnpm.log"
  bash "$tmpdir/pnpm-install-flags.exec.sh"
  test -f .preinstall-marker
  grep -qxF "install --config.confirmModulesPurge=false --config.store-dir=$workspace/.direnv/pnpm-store --ignore-scripts --config.public-hoist-pattern=*" "$tmpdir/pnpm.log"
)

echo "Test 12: CI install failures preserve and classify the pnpm log"
(
  cd "$workspace"
  export HOME="$tmpdir/home"
  export CI=1
  export CI_DIAGNOSTICS_DIR="$tmpdir/diagnostics"
  export TEST_PNPM_FAIL_NETWORK=1
  unset PNPM_HOME
  unset PNPM_STORE_DIR
  unset npm_config_store_dir
  rm -f "$workspace/.direnv/task-cache/pnpm-install/install-state.hash"
  set +e
  output="$(bash "$tmpdir/pnpm-install.exec.sh" 2>&1)"
  exit_code=$?
  set -e
  unset TEST_PNPM_FAIL_NETWORK
  unset CI
  assert_exit_code 42 "$exit_code" "CI install should return the pnpm failure code"
  test -f "$tmpdir/diagnostics/pnpm-install.log"
  grep -qF "ERR_PNPM_META_FETCH_FAIL" "$tmpdir/diagnostics/pnpm-install.log"
  grep -qF "[pnpm] Install failed: registry/network fetch failure" <<< "$output"
  grep -qF "Socket timeout" <<< "$output"
)

echo "Test 13: generated test task runs vitest without pnpm exec"
(
  cd "$workspace/packages/demo"
  output="$(bash "$tmpdir/test-demo.exec.sh")"
  [ "$output" = "vitest-shim:run" ]
)

echo "Test 14: generated storybook task runs storybook without pnpm exec"
(
  cd "$workspace/packages/demo"
  output="$(bash "$tmpdir/storybook-demo.exec.sh")"
  [ "$output" = "storybook-shim:build" ]
)

echo ""
echo "pnpm task smoke test passed"
