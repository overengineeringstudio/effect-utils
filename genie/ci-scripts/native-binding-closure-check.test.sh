#!/usr/bin/env bash
# Prototype test harness for native-binding-closure-check.ts.
# Mirrors genie/ci-scripts/native-dep-policy-audit.test.sh idioms:
# synthetic fixtures, run_bun shim, exit-code + offender-name assertions.
set -euo pipefail

CHECK="${CHECK:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/native-binding-closure-check.ts}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

run_bun() {
  if command -v bun >/dev/null 2>&1; then
    bun "$@"
  elif command -v nix >/dev/null 2>&1; then
    nix run nixpkgs#bun -- "$@"
  else
    echo "bun is not available and nix is not set" >&2
    return 127
  fi
}

# A prepared-tree fixture is: <dir>/pnpm-lock.yaml, <dir>/pnpm-workspace.yaml,
# and <dir>/node_modules/.pnpm/<entry> directories for materialized packages.
write_lock() {
  cat >"$1/pnpm-lock.yaml" <<'YAML'
lockfileVersion: '9.0'

packages:
  rolldown@1.0.3:
    resolution: {integrity: sha512-aaa}
  '@rolldown/binding-linux-arm64-gnu@1.0.3':
    cpu: [arm64]
    os: [linux]
    libc: [glibc]
  '@rolldown/binding-linux-x64-gnu@1.0.3':
    cpu: [x64]
    os: [linux]
    libc: [glibc]
  '@rolldown/binding-darwin-arm64@1.0.3':
    cpu: [arm64]
    os: [darwin]
  '@rolldown/binding-win32-x64-msvc@1.0.3':
    cpu: [x64]
    os: [win32]

snapshots:
  rolldown@1.0.3:
    dependencies:
      '@oxc-project/types': 0.133.0
    optionalDependencies:
      '@rolldown/binding-linux-arm64-gnu': 1.0.3
      '@rolldown/binding-linux-x64-gnu': 1.0.3
      '@rolldown/binding-darwin-arm64': 1.0.3
      '@rolldown/binding-win32-x64-msvc': 1.0.3
YAML
}

write_workspace() {
  cat >"$1/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

supportedArchitectures:
  os: [linux, darwin]
  cpu: [x64, arm64]
  libc: [glibc, musl]
YAML
}

# REGRESSION fixture (multi-document vacuous-pass): a MULTI-DOCUMENT pnpm-lock.yaml. pnpm writes a
# `---`-separated pnpm-CLI bootstrap document BEFORE the workspace document, each
# with its own `packages:`/`snapshots:` sections. The original parser `break`ed at
# the first top-level key past document 1's sections and therefore ONLY saw the ~20
# bootstrap consumers — it never reached the workspace's `rolldown@1.0.3` snapshot,
# so it reported "families: none" and PASSED vacuously on a bindingless tree. The
# single-document fixture above cannot catch that; this one is the real shape.
write_multidoc_lock() {
  cat >"$1/pnpm-lock.yaml" <<'YAML'
---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 11.0.0-rc.5
        version: 11.0.0-rc.5

packages:

  detect-libc@2.1.2:
    resolution: {integrity: sha512-boot}

  pnpm@11.0.0-rc.5:
    resolution: {integrity: sha512-boot}

snapshots:

  detect-libc@2.1.2: {}

  pnpm@11.0.0-rc.5: {}

---
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      rolldown:
        specifier: 1.0.3
        version: 1.0.3

packages:

  rolldown@1.0.3:
    resolution: {integrity: sha512-aaa}
  '@rolldown/binding-linux-arm64-gnu@1.0.3':
    cpu: [arm64]
    os: [linux]
    libc: [glibc]
  '@rolldown/binding-linux-x64-gnu@1.0.3':
    cpu: [x64]
    os: [linux]
    libc: [glibc]
  '@rolldown/binding-darwin-arm64@1.0.3':
    cpu: [arm64]
    os: [darwin]
  '@rolldown/binding-win32-x64-msvc@1.0.3':
    cpu: [x64]
    os: [win32]

snapshots:

  rolldown@1.0.3:
    dependencies:
      '@oxc-project/types': 0.133.0
    optionalDependencies:
      '@rolldown/binding-linux-arm64-gnu': 1.0.3
      '@rolldown/binding-linux-x64-gnu': 1.0.3
      '@rolldown/binding-darwin-arm64': 1.0.3
      '@rolldown/binding-win32-x64-msvc': 1.0.3
YAML
}

mk_entry() { mkdir -p "$1/node_modules/.pnpm/$2"; }

# --- Fixture 1: complete tree (all 3 supported triples present) -> PASS.
f1="$tmp_dir/complete"; mkdir -p "$f1"; write_lock "$f1"; write_workspace "$f1"
mk_entry "$f1" "rolldown@1.0.3"
mk_entry "$f1" "@rolldown+binding-linux-arm64-gnu@1.0.3"
mk_entry "$f1" "@rolldown+binding-linux-x64-gnu@1.0.3"
mk_entry "$f1" "@rolldown+binding-darwin-arm64@1.0.3"
# win32-x64 intentionally absent: not in supportedArchitectures, must NOT be required.

# --- Fixture 2: bindingless tree (--no-optional) -> FAIL naming arm64-gnu.
f2="$tmp_dir/bindingless"; mkdir -p "$f2"; write_lock "$f2"; write_workspace "$f2"
mk_entry "$f2" "rolldown@1.0.3"

# --- Fixture 3: partial tree (host binding present, arm64 missing) -> FAIL.
f3="$tmp_dir/partial"; mkdir -p "$f3"; write_lock "$f3"; write_workspace "$f3"
mk_entry "$f3" "rolldown@1.0.3"
mk_entry "$f3" "@rolldown+binding-linux-x64-gnu@1.0.3"
mk_entry "$f3" "@rolldown+binding-darwin-arm64@1.0.3"

# --- Fixture 4: consumer absent (CLI that never pulls rolldown) -> PASS.
f4="$tmp_dir/no-consumer"; mkdir -p "$f4"; write_lock "$f4"; write_workspace "$f4"
# node_modules/.pnpm exists but has no rolldown consumer.
mkdir -p "$f4/node_modules/.pnpm"
mk_entry "$f4" "some-other-pkg@1.0.0"

fail() { echo "FAIL: $1" >&2; cat "$2" >&2 2>/dev/null || true; exit 1; }

echo "Test 1: complete tree passes (exit 0)"
run_bun "$CHECK" "$f1" >"$tmp_dir/o1" 2>&1 || fail "expected complete tree to pass" "$tmp_dir/o1"

echo "Test 2: bindingless tree fails and names @rolldown/binding-linux-arm64-gnu"
set +e; run_bun "$CHECK" "$f2" >"$tmp_dir/o2" 2>&1; e2=$?; set -e
[ "$e2" -ne 0 ] || fail "expected bindingless tree to fail" "$tmp_dir/o2"
grep -q "@rolldown/binding-linux-arm64-gnu" "$tmp_dir/o2" || fail "did not name the missing arm64-gnu binding" "$tmp_dir/o2"
grep -q "win32" "$tmp_dir/o2" && fail "must NOT require win32 (outside supportedArchitectures)" "$tmp_dir/o2"

echo "Test 3: partial tree fails on the missing arm64 triple"
set +e; run_bun "$CHECK" "$f3" >"$tmp_dir/o3" 2>&1; e3=$?; set -e
[ "$e3" -ne 0 ] || fail "expected partial tree to fail" "$tmp_dir/o3"
grep -q "@rolldown/binding-linux-arm64-gnu" "$tmp_dir/o3" || fail "did not flag missing arm64-gnu" "$tmp_dir/o3"

echo "Test 4: consumer-absent tree passes (no false positive)"
run_bun "$CHECK" "$f4" >"$tmp_dir/o4" 2>&1 || fail "expected consumer-absent tree to pass" "$tmp_dir/o4"

# --- Fixture 5 (multi-document vacuous-pass REGRESSION): MULTI-DOCUMENT lockfile, bindingless.
# The pre-fix parser broke at the `---` document boundary and never reached the
# workspace's rolldown snapshot -> "families: none" -> vacuous PASS. This case
# MUST fail (RED) and name the missing arm64-gnu binding; it is the case that
# would have caught the shipped defect.
f5="$tmp_dir/multidoc-bindingless"; mkdir -p "$f5"; write_multidoc_lock "$f5"; write_workspace "$f5"
mk_entry "$f5" "rolldown@1.0.3"

echo "Test 5: multi-document bindingless lockfile fails (multi-document vacuous-pass regression guard)"
set +e; run_bun "$CHECK" "$f5" >"$tmp_dir/o5" 2>&1; e5=$?; set -e
[ "$e5" -ne 0 ] || fail "REGRESSION: multi-doc bindingless tree passed vacuously (parser broke at '---' boundary)" "$tmp_dir/o5"
grep -q "@rolldown/binding-linux-arm64-gnu" "$tmp_dir/o5" || fail "did not name the missing arm64-gnu binding in multi-doc tree" "$tmp_dir/o5"

# --- Fixture 6: same MULTI-DOCUMENT lockfile, all supported triples present -> PASS.
# Guards against the fix over-correcting into a stuck-RED / non-detecting state:
# proves the workspace document's families are both enumerated AND satisfiable.
f6="$tmp_dir/multidoc-complete"; mkdir -p "$f6"; write_multidoc_lock "$f6"; write_workspace "$f6"
mk_entry "$f6" "rolldown@1.0.3"
mk_entry "$f6" "@rolldown+binding-linux-arm64-gnu@1.0.3"
mk_entry "$f6" "@rolldown+binding-linux-x64-gnu@1.0.3"
mk_entry "$f6" "@rolldown+binding-darwin-arm64@1.0.3"

echo "Test 6: multi-document complete tree passes and detects the rolldown family"
run_bun "$CHECK" "$f6" >"$tmp_dir/o6" 2>&1 || fail "expected multi-doc complete tree to pass" "$tmp_dir/o6"
grep -q "families: @rolldown/binding" "$tmp_dir/o6" || fail "multi-doc: rolldown family not detected (parser still not reaching workspace doc)" "$tmp_dir/o6"

echo ""
echo "native-binding-closure-check tests passed"
