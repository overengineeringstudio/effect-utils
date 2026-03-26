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

echo "Running pnpm task helper tests..."
echo ""

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

echo "Test 1: PNPM_HOME takes precedence for GVS links path"
mkdir -p "$test_dir/pnpm-home/store/v11" "$test_dir/xdg/pnpm/store/v11" "$test_dir/home/.local/share/pnpm/store/v11"
(
  export HOME="$test_dir/home"
  export PNPM_HOME="$test_dir/pnpm-home"
  export XDG_DATA_HOME="$test_dir/xdg"
  assert_eq \
    "$test_dir/pnpm-home/store/v11/links" \
    "$(resolve_gvs_links_dir)" \
    "resolve_gvs_links_dir prefers PNPM_HOME"
)

echo "Test 2: XDG_DATA_HOME is used when PNPM_HOME is unset"
(
  export HOME="$test_dir/home"
  unset PNPM_HOME
  export XDG_DATA_HOME="$test_dir/xdg"
  assert_eq \
    "$test_dir/xdg/pnpm/store/v11/links" \
    "$(resolve_gvs_links_dir)" \
    "resolve_gvs_links_dir uses XDG_DATA_HOME"
)

echo "Test 3: Cache fingerprint changes when GVS path changes"
fingerprint_a="$(cache_fingerprint "workspace-hash" "/tmp/a/store/v11/links")"
fingerprint_b="$(cache_fingerprint "workspace-hash" "/tmp/b/store/v11/links")"
if [ "$fingerprint_a" = "$fingerprint_b" ]; then
  echo "FAIL: cache fingerprint should change when GVS path changes"
  exit 1
fi

echo "Test 4: Projection health passes when symlinked package can resolve deps"
healthy_dir="$test_dir/healthy"
make_projection_fixture "$healthy_dir" 1
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$healthy_dir/node_modules"
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health passes"

echo "Test 5: Projection health ignores packages that do not export ./package.json"
exports_dir="$test_dir/exports"
make_projection_fixture "$exports_dir" 1 1
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$exports_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "projection health should not depend on package.json exports"

echo "Test 6: Projection health fails when symlinked package loses a transitive dep"
stale_dir="$test_dir/stale"
make_projection_fixture "$stale_dir" 0
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$stale_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "projection health detects missing dep"

echo "Test 7: Broken node_modules symlink is rejected before projection checks"
broken_dir="$test_dir/broken"
mkdir -p "$broken_dir/node_modules"
ln -s ../missing "$broken_dir/node_modules/broken"
set +e
check_node_modules_links_healthy node "$PROJECTION_SCRIPT" "$broken_dir/node_modules" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "broken symlink is rejected"

echo ""
echo "All pnpm task helper tests passed"
