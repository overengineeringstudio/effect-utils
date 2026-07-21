#!/usr/bin/env bash
# Test harness for native-binding-closure-check.ts.
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
# with its own `packages:`/`snapshots:` sections. The original line-scanner
# `break`ed at the first top-level key past document 1's sections and therefore
# ONLY saw the ~20 bootstrap consumers — it never reached the workspace's
# `rolldown@1.0.3` snapshot, so it reported "families: none" and PASSED vacuously
# on a bindingless tree. The real multi-document YAML parse now used sees every
# document; this fixture guards against a regression back to a scanner.
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

# PEER-SUFFIX fixture: a real pnpm v9 `snapshots:` consumer key carries its
# resolved peer set in PARENTHESES, one group per peer
# (`rolldown@1.0.3(vite@8.0.16)`), while the materialized virtual-store DIR
# joins peers with UNDERSCORES and maps `/`->`+` (`rolldown@1.0.3_vite@8.0.16`).
# The pre-hardening `stripVersion` split on the last `@` INSIDE the peer group,
# mis-named the consumer, and its `presentInTree` prefix never matched the
# underscore dir -> the consumer was silently skipped and the tree passed
# vacuously. This fixture reproduces that shape so the peer-key skip stays fixed.
write_peer_lock() {
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

snapshots:
  rolldown@1.0.3(vite@8.0.16):
    dependencies:
      '@oxc-project/types': 0.133.0
    optionalDependencies:
      '@rolldown/binding-linux-arm64-gnu': 1.0.3
      '@rolldown/binding-linux-x64-gnu': 1.0.3
      '@rolldown/binding-darwin-arm64': 1.0.3
YAML
}

# MUSL fixture: supportedArchitectures declares libc [glibc, musl], so a musl
# binding within support must be present. Exercises multi-libc handling — the
# musl triple must be required and named when missing.
write_musl_lock() {
  cat >"$1/pnpm-lock.yaml" <<'YAML'
lockfileVersion: '9.0'

packages:
  rolldown@1.0.3:
    resolution: {integrity: sha512-aaa}
  '@rolldown/binding-linux-arm64-gnu@1.0.3':
    cpu: [arm64]
    os: [linux]
    libc: [glibc]
  '@rolldown/binding-linux-arm64-musl@1.0.3':
    cpu: [arm64]
    os: [linux]
    libc: [musl]

snapshots:
  rolldown@1.0.3:
    dependencies:
      '@oxc-project/types': 0.133.0
    optionalDependencies:
      '@rolldown/binding-linux-arm64-gnu': 1.0.3
      '@rolldown/binding-linux-arm64-musl': 1.0.3
YAML
}

# PRE-v9 fixture: a v6 lockfile has no `snapshots:` model, so the check cannot
# resolve which consumer pulls which binding. It must FAIL CLOSED (not pass
# vacuously) in fail mode, and degrade to a warning in warn mode.
write_v6_lock() {
  cat >"$1/pnpm-lock.yaml" <<'YAML'
lockfileVersion: '6.0'

dependencies:
  rolldown:
    specifier: 1.0.3
    version: 1.0.3

packages:
  /rolldown@1.0.3:
    resolution: {integrity: sha512-aaa}
YAML
}

# BLIND-SNAPSHOTS fixture: a `snapshots:` section is present but empty (zero
# consumers). The check must refuse to pass vacuously (fail-closed floor #3).
write_empty_snapshots_lock() {
  cat >"$1/pnpm-lock.yaml" <<'YAML'
lockfileVersion: '9.0'

packages:
  rolldown@1.0.3:
    resolution: {integrity: sha512-aaa}

snapshots:
YAML
}

# DROPPED-REFERENCES fixture: within-support pure-artifact binding packages exist
# in `packages:` and their dirs are materialized, but the consumer snapshot omits
# the optionalDependencies that reference them. detectActiveFamilies() is empty
# while the tree plainly carries bindings -> fail-closed floor (3b + 4).
write_dropped_refs_lock() {
  cat >"$1/pnpm-lock.yaml" <<'YAML'
lockfileVersion: '9.0'

packages:
  rolldown@1.0.3:
    resolution: {integrity: sha512-aaa}
  '@rolldown/binding-linux-arm64-gnu@1.0.3':
    cpu: [arm64]
    os: [linux]
    libc: [glibc]

snapshots:
  rolldown@1.0.3:
    dependencies:
      '@oxc-project/types': 0.133.0
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
f5="$tmp_dir/multidoc-bindingless"; mkdir -p "$f5"; write_multidoc_lock "$f5"; write_workspace "$f5"
mk_entry "$f5" "rolldown@1.0.3"

echo "Test 5: multi-document bindingless lockfile fails (multi-document vacuous-pass regression guard)"
set +e; run_bun "$CHECK" "$f5" >"$tmp_dir/o5" 2>&1; e5=$?; set -e
[ "$e5" -ne 0 ] || fail "REGRESSION: multi-doc bindingless tree passed vacuously" "$tmp_dir/o5"
grep -q "@rolldown/binding-linux-arm64-gnu" "$tmp_dir/o5" || fail "did not name the missing arm64-gnu binding in multi-doc tree" "$tmp_dir/o5"

# --- Fixture 6: same MULTI-DOCUMENT lockfile, all supported triples present -> PASS.
f6="$tmp_dir/multidoc-complete"; mkdir -p "$f6"; write_multidoc_lock "$f6"; write_workspace "$f6"
mk_entry "$f6" "rolldown@1.0.3"
mk_entry "$f6" "@rolldown+binding-linux-arm64-gnu@1.0.3"
mk_entry "$f6" "@rolldown+binding-linux-x64-gnu@1.0.3"
mk_entry "$f6" "@rolldown+binding-darwin-arm64@1.0.3"

echo "Test 6: multi-document complete tree passes and detects the rolldown family"
run_bun "$CHECK" "$f6" >"$tmp_dir/o6" 2>&1 || fail "expected multi-doc complete tree to pass" "$tmp_dir/o6"
grep -q "families: @rolldown/binding" "$tmp_dir/o6" || fail "multi-doc: rolldown family not detected" "$tmp_dir/o6"

# --- Fixture 7 (PEER-SUFFIX): parens snapshot key, underscore-joined dir.
f7="$tmp_dir/peer-bindingless"; mkdir -p "$f7"; write_peer_lock "$f7"; write_workspace "$f7"
mk_entry "$f7" "rolldown@1.0.3_vite@8.0.16"

echo "Test 7: peer-suffixed consumer key is not skipped — bindingless tree fails"
set +e; run_bun "$CHECK" "$f7" >"$tmp_dir/o7" 2>&1; e7=$?; set -e
[ "$e7" -ne 0 ] || fail "REGRESSION: peer-suffixed consumer skipped -> vacuous pass" "$tmp_dir/o7"
grep -q "@rolldown/binding-linux-arm64-gnu" "$tmp_dir/o7" || fail "peer-suffixed: did not name missing arm64-gnu" "$tmp_dir/o7"

# --- Fixture 8 (PEER-SUFFIX complete): all declared triples present -> PASS.
f8="$tmp_dir/peer-complete"; mkdir -p "$f8"; write_peer_lock "$f8"; write_workspace "$f8"
mk_entry "$f8" "rolldown@1.0.3_vite@8.0.16"
mk_entry "$f8" "@rolldown+binding-linux-arm64-gnu@1.0.3"
mk_entry "$f8" "@rolldown+binding-linux-x64-gnu@1.0.3"
mk_entry "$f8" "@rolldown+binding-darwin-arm64@1.0.3"

echo "Test 8: peer-suffixed complete tree passes and detects the family"
run_bun "$CHECK" "$f8" >"$tmp_dir/o8" 2>&1 || fail "expected peer-suffixed complete tree to pass" "$tmp_dir/o8"
grep -q "families: @rolldown/binding" "$tmp_dir/o8" || fail "peer-suffixed: family not detected" "$tmp_dir/o8"

# --- Fixture 9 (MUSL): musl binding within support, missing -> FAIL naming musl.
f9="$tmp_dir/musl-partial"; mkdir -p "$f9"; write_musl_lock "$f9"; write_workspace "$f9"
mk_entry "$f9" "rolldown@1.0.3"
mk_entry "$f9" "@rolldown+binding-linux-arm64-gnu@1.0.3"

echo "Test 9: missing musl binding fails and names the musl triple"
set +e; run_bun "$CHECK" "$f9" >"$tmp_dir/o9" 2>&1; e9=$?; set -e
[ "$e9" -ne 0 ] || fail "expected missing musl binding to fail" "$tmp_dir/o9"
grep -q "@rolldown/binding-linux-arm64-musl" "$tmp_dir/o9" || fail "did not name the missing musl binding" "$tmp_dir/o9"

# --- Fixture 10 (MUSL complete): both glibc + musl present -> PASS.
f10="$tmp_dir/musl-complete"; mkdir -p "$f10"; write_musl_lock "$f10"; write_workspace "$f10"
mk_entry "$f10" "rolldown@1.0.3"
mk_entry "$f10" "@rolldown+binding-linux-arm64-gnu@1.0.3"
mk_entry "$f10" "@rolldown+binding-linux-arm64-musl@1.0.3"

echo "Test 10: musl-complete tree passes"
run_bun "$CHECK" "$f10" >"$tmp_dir/o10" 2>&1 || fail "expected musl-complete tree to pass" "$tmp_dir/o10"

# --- Fixture 11 (FAIL-CLOSED: pre-v9). fail mode -> exit 1; warn mode -> exit 0.
f11="$tmp_dir/v6"; mkdir -p "$f11"; write_v6_lock "$f11"; write_workspace "$f11"
mk_entry "$f11" "rolldown@1.0.3"

echo "Test 11a: pre-v9 lockfile fails closed in fail mode"
set +e; run_bun "$CHECK" "$f11" >"$tmp_dir/o11a" 2>&1; e11a=$?; set -e
[ "$e11a" -ne 0 ] || fail "expected pre-v9 lockfile to fail closed" "$tmp_dir/o11a"
grep -qi "predates the pnpm v9" "$tmp_dir/o11a" || fail "pre-v9: did not name the version floor" "$tmp_dir/o11a"

echo "Test 11b: pre-v9 lockfile degrades to warning in warn mode (exit 0)"
NBCC_ENGAGEMENT=warn run_bun "$CHECK" "$f11" >"$tmp_dir/o11b" 2>&1 || fail "warn mode must not hard-fail on pre-v9" "$tmp_dir/o11b"

# --- Fixture 12 (FAIL-CLOSED: empty snapshots section) -> fail closed.
f12="$tmp_dir/empty-snapshots"; mkdir -p "$f12"; write_empty_snapshots_lock "$f12"; write_workspace "$f12"
mk_entry "$f12" "rolldown@1.0.3"

echo "Test 12: empty snapshots section fails closed (no vacuous pass)"
set +e; run_bun "$CHECK" "$f12" >"$tmp_dir/o12" 2>&1; e12=$?; set -e
[ "$e12" -ne 0 ] || fail "expected empty-snapshots tree to fail closed" "$tmp_dir/o12"
grep -qi "zero consumer entries parsed" "$tmp_dir/o12" || fail "empty-snapshots: did not name the floor" "$tmp_dir/o12"

# --- Fixture 13 (FAIL-CLOSED: dropped references, tree carries bindings) -> fail closed.
f13="$tmp_dir/dropped-refs"; mkdir -p "$f13"; write_dropped_refs_lock "$f13"; write_workspace "$f13"
mk_entry "$f13" "rolldown@1.0.3"
mk_entry "$f13" "@rolldown+binding-linux-arm64-gnu@1.0.3"

echo "Test 13: tree carries bindings but no family derived -> fail closed"
set +e; run_bun "$CHECK" "$f13" >"$tmp_dir/o13" 2>&1; e13=$?; set -e
[ "$e13" -ne 0 ] || fail "expected dropped-refs tree to fail closed" "$tmp_dir/o13"
grep -qi "not seeing the tree\|dropped the references" "$tmp_dir/o13" || fail "dropped-refs: did not name the floor" "$tmp_dir/o13"

echo ""
echo "native-binding-closure-check tests passed"
