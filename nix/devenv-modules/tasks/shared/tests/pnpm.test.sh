#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
HELPERS_SCRIPT="$ROOT/nix/devenv-modules/tasks/shared/pnpm-task-helpers.sh"
PROJECTION_SCRIPT="$ROOT/nix/devenv-modules/tasks/shared/check-node-modules-projection-health.cjs"

# The unit-style shell tests should execute the same helper implementations as
# the generated task scripts so they catch real regressions instead of drift in
# duplicated test-only copies.
source "$HELPERS_SCRIPT"

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

make_projection_fixture() {
  local root="$1"
  local with_dep="$2"
  local dep_blocks_package_json_export="${3:-0}"

  mkdir -p "$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"
  mkdir -p "$root/node_modules"
  cat > "$root/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/package.json" <<'EOF'
{"name":"pkg","dependencies":{"dep":"1.0.0"}}
EOF
  ln -s .pnpm/pkg@1.0.0/node_modules/pkg "$root/node_modules/pkg"

  if [ "$with_dep" = "1" ]; then
    mkdir -p "$root/node_modules/.pnpm/pkg@1.0.0/node_modules/dep"
    if [ "$dep_blocks_package_json_export" = "1" ]; then
      cat > "$root/node_modules/.pnpm/pkg@1.0.0/node_modules/dep/package.json" <<'EOF'
{"name":"dep","exports":{".":"./index.js"}}
EOF
      cat > "$root/node_modules/.pnpm/pkg@1.0.0/node_modules/dep/index.js" <<'EOF'
module.exports = {}
EOF
    else
      cat > "$root/node_modules/.pnpm/pkg@1.0.0/node_modules/dep/package.json" <<'EOF'
{"name":"dep"}
EOF
    fi
  fi
}

make_missing_export_fixture() {
  local root="$1"
  local package_root="$root/store/v11/links/pkg/1.0.0/hash/node_modules/pkg"

  mkdir -p "$package_root"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["src"],"exports":{"./vitest":{"default":"./src/vitest.js"}}}
EOF
  ln -s ../store/v11/links/pkg/1.0.0/hash/node_modules/pkg "$root/node_modules/pkg"
}

make_unshipped_conditional_export_fixture() {
  local root="$1"
  local package_root="$root/store/v11/links/pkg/1.0.0/hash/node_modules/pkg"

  mkdir -p "$package_root/dist"
  mkdir -p "$root/node_modules"
  cat > "$package_root/package.json" <<'EOF'
{"name":"pkg","files":["dist"],"exports":{".":{"custom-condition":"./src/index.ts","default":"./dist/index.js"}}}
EOF
  touch "$package_root/dist/index.js"
  ln -s ../store/v11/links/pkg/1.0.0/hash/node_modules/pkg "$root/node_modules/pkg"
}

make_bin_fixture() {
  local root="$1"

  mkdir -p "$root/node_modules/fake-tool/bin" "$root/node_modules/.bin"
  cat > "$root/node_modules/fake-tool/package.json" <<'EOF'
{"name":"fake-tool","bin":{"fake-tool":"bin/fake-tool.js","alt-tool":"bin/fake-tool.js"}}
EOF
  cat > "$root/node_modules/fake-tool/bin/fake-tool.js" <<'EOF'
#!/usr/bin/env node
process.stdout.write(`fake-tool-direct:${process.argv.slice(2).join(',')}\n`)
EOF
  chmod +x "$root/node_modules/fake-tool/bin/fake-tool.js"
  cat > "$root/node_modules/.bin/fake-tool" <<'EOF'
#!/usr/bin/env bash
printf 'fake-tool-shim:%s\n' "$*"
EOF
  chmod +x "$root/node_modules/.bin/fake-tool"
}

make_bin_fixture_without_shim() {
  local root="$1"

  mkdir -p "$root/node_modules/fallback-tool/bin"
  cat > "$root/node_modules/fallback-tool/package.json" <<'EOF'
{"name":"fallback-tool","bin":{"fallback-tool":"bin/fallback-tool.js"}}
EOF
  cat > "$root/node_modules/fallback-tool/bin/fallback-tool.js" <<'EOF'
#!/usr/bin/env node
process.stdout.write(`fallback-tool-direct:${process.argv.slice(2).join(',')}\n`)
EOF
  chmod +x "$root/node_modules/fallback-tool/bin/fallback-tool.js"
}

echo "Running pnpm task helper tests..."
echo ""

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

echo "Test 1: explicit store-dir takes precedence for GVS links path"
mkdir -p "$test_dir/pnpm-store/v11" "$test_dir/pnpm-home/store/v11" "$test_dir/xdg/pnpm/store/v11" "$test_dir/home/.local/share/pnpm/store/v11"
(
  export HOME="$test_dir/home"
  export npm_config_store_dir="$test_dir/pnpm-store"
  export PNPM_STORE_DIR="$test_dir/ignored-pnpm-store"
  export PNPM_HOME="$test_dir/pnpm-home"
  export XDG_DATA_HOME="$test_dir/xdg"
  assert_eq \
    "$test_dir/pnpm-store/v11/links" \
    "$(resolve_gvs_links_dir)" \
    "resolve_gvs_links_dir prefers npm_config_store_dir"
)

echo "Test 2: PNPM_STORE_DIR is used when npm_config_store_dir is unset"
(
  export HOME="$test_dir/home"
  unset npm_config_store_dir
  export PNPM_STORE_DIR="$test_dir/pnpm-store"
  export PNPM_HOME="$test_dir/pnpm-home"
  export XDG_DATA_HOME="$test_dir/xdg"
  assert_eq \
    "$test_dir/pnpm-store/v11/links" \
    "$(resolve_gvs_links_dir)" \
    "resolve_gvs_links_dir uses PNPM_STORE_DIR"
)

echo "Test 3: PNPM_HOME is used when store-dir is unset"
(
  export HOME="$test_dir/home"
  unset npm_config_store_dir
  unset PNPM_STORE_DIR
  export PNPM_HOME="$test_dir/pnpm-home"
  export XDG_DATA_HOME="$test_dir/xdg"
  assert_eq \
    "$test_dir/pnpm-home/store/v11/links" \
    "$(resolve_gvs_links_dir)" \
    "resolve_gvs_links_dir falls back to PNPM_HOME"
)

echo "Test 4: XDG_DATA_HOME is used when PNPM_HOME is unset"
(
  export HOME="$test_dir/home"
  unset npm_config_store_dir
  unset PNPM_STORE_DIR
  unset PNPM_HOME
  export XDG_DATA_HOME="$test_dir/xdg"
  assert_eq \
    "$test_dir/xdg/pnpm/store/v11/links" \
    "$(resolve_gvs_links_dir)" \
    "resolve_gvs_links_dir uses XDG_DATA_HOME"
)

echo "Test 5: ensure_local_pnpm_home_default sets a workspace-local default"
(
  unset PNPM_HOME
  ensure_local_pnpm_home_default "$test_dir/workspace"
  assert_eq \
    "$test_dir/workspace/.pnpm-home" \
    "$PNPM_HOME" \
    "ensure_local_pnpm_home_default sets PNPM_HOME"
)

echo "Test 6: ensure_local_pnpm_home_default preserves an explicit PNPM_HOME"
(
  export PNPM_HOME="$test_dir/custom-home"
  ensure_local_pnpm_home_default "$test_dir/workspace"
  assert_eq \
    "$test_dir/custom-home" \
    "$PNPM_HOME" \
    "ensure_local_pnpm_home_default keeps explicit PNPM_HOME"
)

echo "Test 7: Cache fingerprint changes when GVS path changes"
fingerprint_a="$(cache_fingerprint "workspace-hash" "/tmp/a/store/v11/links")"
fingerprint_b="$(cache_fingerprint "workspace-hash" "/tmp/b/store/v11/links")"
if [ "$fingerprint_a" = "$fingerprint_b" ]; then
  echo "FAIL: cache fingerprint should change when GVS path changes"
  exit 1
fi

echo "Test 8: resolve_package_bin prefers package-local .bin shims"
bin_fixture="$test_dir/bin-fixture"
make_bin_fixture "$bin_fixture"
resolved_bin="$(resolve_package_bin fake-tool fake-tool "$bin_fixture")"
expected_bin="$bin_fixture/node_modules/.bin/fake-tool"
assert_eq \
  "$expected_bin" \
  "$resolved_bin" \
  "resolve_package_bin prefers the generated .bin shim"

echo "Test 9: run_package_bin executes the .bin shim when present"
output="$(cd "$bin_fixture" && run_package_bin fake-tool fake-tool alpha beta)"
assert_eq \
  "fake-tool-shim:alpha beta" \
  "$output" \
  "run_package_bin executes the resolved shim"

echo "Test 10: resolve_package_bin falls back to the package bin file"
fallback_fixture="$test_dir/fallback-bin-fixture"
make_bin_fixture_without_shim "$fallback_fixture"
resolved_fallback_bin="$(resolve_package_bin fallback-tool fallback-tool "$fallback_fixture")"
expected_fallback_bin="$(cd "$fallback_fixture/node_modules/fallback-tool/bin" && pwd -P)/fallback-tool.js"
assert_eq \
  "$expected_fallback_bin" \
  "$resolved_fallback_bin" \
  "resolve_package_bin falls back to the package bin file"

echo "Test 11: Projection health passes when symlinked package can resolve deps"
healthy_dir="$test_dir/healthy"
make_projection_fixture "$healthy_dir" 1
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$healthy_dir/node_modules"
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health passes"

echo "Test 12: Projection health ignores packages that do not export ./package.json"
exports_dir="$test_dir/exports"
make_projection_fixture "$exports_dir" 1 1
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$exports_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health should not depend on package.json exports"

echo "Test 13: Projection health fails when symlinked package loses a transitive dep"
stale_dir="$test_dir/stale"
make_projection_fixture "$stale_dir" 0
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$stale_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "projection health detects missing dep"

echo "Test 14: Broken node_modules symlink is rejected before projection checks"
broken_dir="$test_dir/broken"
mkdir -p "$broken_dir/node_modules"
ln -s ../missing "$broken_dir/node_modules/broken"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$broken_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "broken symlink is rejected"

echo "Test 15: Projection health fails when a package export target is missing"
missing_export_dir="$test_dir/missing-export"
make_missing_export_fixture "$missing_export_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$missing_export_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "projection health detects missing package export target"

echo "Test 16: Projection health ignores unshipped conditional export targets"
unshipped_export_dir="$test_dir/unshipped-export"
make_unshipped_conditional_export_fixture "$unshipped_export_dir"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$unshipped_export_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health ignores export targets outside package files"

echo ""
echo "All pnpm task helper tests passed"
