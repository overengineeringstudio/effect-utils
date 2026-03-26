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
mkdir -p "$workspace/.direnv/task-cache" "$workspace/.pnpm-home-a/store/v11" "$workspace/.pnpm-home-b/store/v11" "$tmpdir/bin"

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

cat > "$tmpdir/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TEST_PNPM_LOG:?}"
if [ "${1:-}" = "--version" ]; then
  echo "11.0.0-beta.2"
  exit 0
fi
if [ "${1:-}" = "install" ]; then
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
exit 0
EOF
chmod +x "$tmpdir/bin/flock"

extract_task_script "$workspace" "exec" "$tmpdir/pnpm-install.exec.sh"
extract_task_script "$workspace" "status" "$tmpdir/pnpm-install.status.sh"
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
  test -d "$workspace/node_modules"
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

echo "Test 4: status misses after effective GVS path changes"
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

echo "Test 5: exec invoked pnpm version and install"
grep -qxF -- "--version" "$tmpdir/pnpm.log"
grep -q "^install " "$tmpdir/pnpm.log"

echo ""
echo "pnpm task smoke test passed"
