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
            lintPaths = [ \".\" ];
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
cat > "$tmpdir/bin/oxfmt" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "${TEST_OXFMT_ARGS:?}"
EOF
chmod +x "$tmpdir/bin/oxfmt"
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
cat > "$workspace/fixture.kdl" <<'EOF'
node "unsupported"
EOF
cat > "$workspace/lib.rs" <<'EOF'
pub fn unsupported() {}
EOF
cat > "$workspace/readme.md" <<'EOF'
# Supported by oxfmt
EOF
cat > "$workspace/config.json" <<'EOF'
{"supported": true}
EOF
cat > "$workspace/module.mts" <<'EOF'
export const module = true
EOF
cat > "$workspace/common.cts" <<'EOF'
export const common = true
EOF
cat > "$workspace/view.vue" <<'EOF'
<script setup lang="ts">const view = true</script>
EOF
cat > "$workspace/card.svelte" <<'EOF'
<script lang="ts">const card = true</script>
EOF
cat > "$workspace/page.astro" <<'EOF'
---
const page = true
---
EOF
cat > "$workspace/config.json5" <<'EOF'
{supported: true}
EOF
cat > "$workspace/styles.scss" <<'EOF'
.supported { color: red; }
EOF
cat > "$workspace/notes.mdx" <<'EOF'
# Supported by oxfmt
EOF
cat > "$workspace/query.graphql" <<'EOF'
query Supported { node { id } }
EOF
cat > "$workspace/template.hbs" <<'EOF'
<p>{{supported}}</p>
EOF

(
  cd "$workspace"
  git init --quiet
  git add .gitignore keep.ts deleted.ts fixture.kdl lib.rs readme.md config.json \
    module.mts common.cts view.vue card.svelte page.astro config.json5 styles.scss \
    notes.mdx query.graphql template.hbs
  rm deleted.ts
)

extract_lint_task_script "lint:check:oxlint" "$tmpdir/lint-check-oxlint.sh"
extract_lint_task_script "lint:check:format" "$tmpdir/lint-check-format.sh"

export PATH="$tmpdir/bin:$PATH"
export TEST_OXLINT_ARGS="$tmpdir/oxlint-args.txt"
export TEST_OXFMT_ARGS="$tmpdir/oxfmt-args.txt"

echo "Test 1: lint task skips tracked paths deleted from the worktree"
(
  cd "$workspace"
  bash "$tmpdir/lint-check-oxlint.sh"
)

assert_contains "keep.ts" "$TEST_OXLINT_ARGS" "tracked existing file is linted"
assert_contains "new.ts" "$TEST_OXLINT_ARGS" "untracked non-ignored file is linted"
assert_contains "module.mts" "$TEST_OXLINT_ARGS" "MTS file is linted by oxlint"
assert_contains "common.cts" "$TEST_OXLINT_ARGS" "CTS file is linted by oxlint"
assert_contains "view.vue" "$TEST_OXLINT_ARGS" "Vue file is linted by oxlint"
assert_contains "card.svelte" "$TEST_OXLINT_ARGS" "Svelte file is linted by oxlint"
assert_contains "page.astro" "$TEST_OXLINT_ARGS" "Astro file is linted by oxlint"
assert_not_contains "deleted.ts" "$TEST_OXLINT_ARGS" "tracked deleted file is filtered"
assert_not_contains "node_modules/pkg/ignored.ts" "$TEST_OXLINT_ARGS" "ignored file is not linted"
assert_not_contains "fixture.kdl" "$TEST_OXLINT_ARGS" "unsupported KDL fixture is not linted by oxlint"
assert_not_contains "lib.rs" "$TEST_OXLINT_ARGS" "unsupported Rust file is not linted by oxlint"
assert_not_contains "readme.md" "$TEST_OXLINT_ARGS" "Markdown file is not linted by oxlint"
assert_not_contains "config.json" "$TEST_OXLINT_ARGS" "JSON file is not linted by oxlint"
assert_not_contains "config.json5" "$TEST_OXLINT_ARGS" "JSON5 file is not linted by oxlint"
assert_not_contains "styles.scss" "$TEST_OXLINT_ARGS" "SCSS file is not linted by oxlint"
assert_not_contains "notes.mdx" "$TEST_OXLINT_ARGS" "MDX file is not linted by oxlint"
assert_not_contains "query.graphql" "$TEST_OXLINT_ARGS" "GraphQL file is not linted by oxlint"
assert_not_contains "template.hbs" "$TEST_OXLINT_ARGS" "Handlebars file is not linted by oxlint"

echo ""
echo "Test 2: format task keeps oxfmt-supported files and skips unsupported paths"
(
  cd "$workspace"
  bash "$tmpdir/lint-check-format.sh"
)

assert_contains "keep.ts" "$TEST_OXFMT_ARGS" "tracked TypeScript file is formatted"
assert_contains "new.ts" "$TEST_OXFMT_ARGS" "untracked TypeScript file is formatted"
assert_contains "module.mts" "$TEST_OXFMT_ARGS" "MTS file is formatted"
assert_contains "common.cts" "$TEST_OXFMT_ARGS" "CTS file is formatted"
assert_contains "view.vue" "$TEST_OXFMT_ARGS" "Vue file is formatted"
assert_contains "readme.md" "$TEST_OXFMT_ARGS" "Markdown file is formatted"
assert_contains "config.json" "$TEST_OXFMT_ARGS" "JSON file is formatted"
assert_contains "config.json5" "$TEST_OXFMT_ARGS" "JSON5 file is formatted"
assert_contains "styles.scss" "$TEST_OXFMT_ARGS" "SCSS file is formatted"
assert_contains "notes.mdx" "$TEST_OXFMT_ARGS" "MDX file is formatted"
assert_contains "query.graphql" "$TEST_OXFMT_ARGS" "GraphQL file is formatted"
assert_contains "template.hbs" "$TEST_OXFMT_ARGS" "Handlebars file is formatted"
assert_not_contains "deleted.ts" "$TEST_OXFMT_ARGS" "tracked deleted file is filtered for oxfmt"
assert_not_contains "fixture.kdl" "$TEST_OXFMT_ARGS" "unsupported KDL fixture is not formatted"
assert_not_contains "lib.rs" "$TEST_OXFMT_ARGS" "unsupported Rust file is not formatted"
assert_not_contains "node_modules/pkg/ignored.ts" "$TEST_OXFMT_ARGS" "ignored file is not formatted"

echo ""
echo "All lint-oxc file list tests passed"
