#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
SCRIPT="$ROOT/nix/devenv-modules/tasks/shared/changesets/check-bodies.ts"

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

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"

  if ! printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "FAIL: $label"
    echo "  expected to contain: $needle"
    echo "  actual output:"
    printf '%s\n' "$haystack" | sed 's/^/    /'
    exit 1
  fi
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

run_check() {
  # $1 = fixture subdir name, capture stdout+stderr, never abort the test on exit code
  local fixture="$1"
  local out
  set +e
  out="$(bun "$SCRIPT" --dir "$tmpdir/$fixture" 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "$out"
  return $rc
}

# Case 1: empty changeset with empty body — must fail.
mkdir -p "$tmpdir/case1"
cat > "$tmpdir/case1/empty.md" <<'EOF'
---
---
EOF

set +e
output="$(run_check case1)"
rc=$?
set -e
assert_exit_code 1 "$rc" "empty changeset with empty body should fail"
assert_contains "$output" "empty.md" "violation should mention the offending file"
assert_contains "$output" "empty changeset with no body" "violation should explain the rule"

# Case 2: empty frontmatter but a body explaining the intentional no-op — must pass.
mkdir -p "$tmpdir/case2"
cat > "$tmpdir/case2/empty-with-body.md" <<'EOF'
---
---

Internal docs-only change. No package release needed.
EOF

set +e
output="$(run_check case2)"
rc=$?
set -e
assert_exit_code 0 "$rc" "empty frontmatter with body should pass"
assert_contains "$output" "well-formed" "success message should be emitted"

# Case 3: real package bump (frontmatter content present) with no body — must pass.
# Changesets itself fills in the release notes; the script does not require a body
# when at least one package is bumped.
mkdir -p "$tmpdir/case3"
cat > "$tmpdir/case3/bump.md" <<'EOF'
---
'@scope/pkg': patch
---
EOF

set +e
output="$(run_check case3)"
rc=$?
set -e
assert_exit_code 0 "$rc" "frontmatter with package bumps should pass"

# Case 4: README.md must be ignored even when otherwise malformed.
mkdir -p "$tmpdir/case4"
cat > "$tmpdir/case4/README.md" <<'EOF'
# Changesets

This directory holds release-intent records.
EOF

set +e
output="$(run_check case4)"
rc=$?
set -e
assert_exit_code 0 "$rc" "README.md must be ignored"

# Case 5: missing closing `---` fence — must be reported.
mkdir -p "$tmpdir/case5"
cat > "$tmpdir/case5/broken.md" <<'EOF'
---
'@scope/pkg': patch

still no closing fence
EOF

set +e
output="$(run_check case5)"
rc=$?
set -e
assert_exit_code 1 "$rc" "missing closing frontmatter fence should fail"
assert_contains "$output" "malformed YAML frontmatter" "violation should explain the parse failure"

# Case 6: mixed directory — one good, one bad. Must fail and report only the bad one.
mkdir -p "$tmpdir/case6"
cat > "$tmpdir/case6/good.md" <<'EOF'
---
'@scope/pkg': patch
---
EOF
cat > "$tmpdir/case6/bad.md" <<'EOF'
---
---
EOF

set +e
output="$(run_check case6)"
rc=$?
set -e
assert_exit_code 1 "$rc" "mixed directory with one violation should fail"
assert_contains "$output" "bad.md" "violation should mention only the offending file"
if printf '%s' "$output" | grep -q 'good\.md'; then
  echo "FAIL: well-formed changeset should not be reported"
  printf '%s\n' "$output"
  exit 1
fi

echo "OK: changeset-check-bodies"
