#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

assert_contains() {
  local needle="$1"
  local file="$2"
  local label="$3"

  if ! grep -Fxq "$needle" "$file"; then
    echo "FAIL: $label"
    echo "  missing: $needle"
    echo "  file contents:"
    sed -n '1,120p' "$file"
    exit 1
  fi
  echo "  ok: $label"
}

assert_not_contains() {
  local needle="$1"
  local file="$2"
  local label="$3"

  if grep -Fxq "$needle" "$file"; then
    echo "FAIL: $label"
    echo "  unexpected: $needle"
    echo "  file contents:"
    sed -n '1,120p' "$file"
    exit 1
  fi
  echo "  ok: $label"
}

extract_lint_task_script() {
  local task_name="$1"
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
          ((import $ROOT/nix/devenv-modules/tasks/shared/lint-oxc.nix {
            lintPaths = [ \"*.ts\" ];
            geniePatterns = [ ];
            genieCoverageDirs = [ \".\" ];
          }) {
            pkgs = pkgs;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"${task_name}\".exec
  " > "$output_path"
  chmod +x "$output_path"
}

echo "Running lint-oxc file list tests..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

workspace="$tmpdir/workspace"
mkdir -p "$workspace/node_modules/pkg" "$tmpdir/bin"

cat > "$tmpdir/bin/oxlint" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "${TEST_OXLINT_ARGS:?}"
EOF
chmod +x "$tmpdir/bin/oxlint"

cat > "$workspace/keep.ts" <<'EOF'
export const keep = true
EOF
cat > "$workspace/deleted.ts" <<'EOF'
export const deleted = true
EOF
cat > "$workspace/new.ts" <<'EOF'
export const fresh = true
EOF
cat > "$workspace/.gitignore" <<'EOF'
node_modules/
EOF
cat > "$workspace/node_modules/pkg/ignored.ts" <<'EOF'
export const ignored = true
EOF

(
  cd "$workspace"
  git init --quiet
  git add .gitignore keep.ts deleted.ts
  rm deleted.ts
)

extract_lint_task_script "lint:check:oxlint" "$tmpdir/lint-check-oxlint.sh"

export PATH="$tmpdir/bin:$PATH"
export TEST_OXLINT_ARGS="$tmpdir/oxlint-args.txt"

echo "Test 1: lint task skips tracked paths deleted from the worktree"
(
  cd "$workspace"
  bash "$tmpdir/lint-check-oxlint.sh"
)

assert_contains "keep.ts" "$TEST_OXLINT_ARGS" "tracked existing file is linted"
assert_contains "new.ts" "$TEST_OXLINT_ARGS" "untracked non-ignored file is linted"
assert_not_contains "deleted.ts" "$TEST_OXLINT_ARGS" "tracked deleted file is filtered"
assert_not_contains "node_modules/pkg/ignored.ts" "$TEST_OXLINT_ARGS" "ignored file is not linted"

echo ""
echo "All lint-oxc file list tests passed"
