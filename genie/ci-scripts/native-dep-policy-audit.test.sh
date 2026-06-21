#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AUDIT="$ROOT/genie/ci-scripts/native-dep-policy-audit.ts"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

run_bun() {
  if command -v bun >/dev/null 2>&1; then
    bun "$@"
  elif command -v nix >/dev/null 2>&1; then
    nix run nixpkgs#bun -- "$@"
  elif [ -n "${DEVENV_BIN:-}" ]; then
    "$DEVENV_BIN" shell --no-reload -- bash -lc 'bun "$@"' bash "$@"
  else
    echo "bun is not available and neither nix nor DEVENV_BIN is set" >&2
    return 127
  fi
}

# Clean fixture: every present family is classified by nativeDependencyPolicy.
# node-pty resolves via link: (no gated registry key); its nix file is real.
clean_lock="$tmp_dir/clean.yaml"
cat >"$clean_lock" <<'YAML'
lockfileVersion: '9.0'
packages:
  '@rollup/rollup-linux-x64-gnu@4.60.2':
    cpu: [x64]
    os: [linux]
  '@esbuild/linux-x64@0.27.7':
    cpu: [x64]
    os: [linux]
  '@opentui/core-linux-x64@0.4.1':
    cpu: [x64]
    os: [linux]
  '@parcel/watcher-linux-x64-glibc@2.5.1':
    cpu: [x64]
    os: [linux]
    libc: [glibc]
  '@parcel/watcher@2.5.1': {}
  '@myobie/pty@0.1.0': {}
  esbuild@0.27.7: {}
  fsevents@2.3.3:
    os: [darwin]
  msgpackr-extract@3.0.3: {}
  '@msgpackr-extract/msgpackr-extract-linux-x64@3.0.3':
    cpu: [x64]
    os: [linux]
  node-pty@1.1.0: {}
YAML

# Failing fixture: an unclassified gated native family (@swc/core-*) appears.
dirty_lock="$tmp_dir/dirty.yaml"
cat >"$dirty_lock" <<'YAML'
lockfileVersion: '9.0'
packages:
  '@rollup/rollup-linux-x64-gnu@4.60.2':
    cpu: [x64]
    os: [linux]
  '@parcel/watcher@2.5.1': {}
  '@myobie/pty@0.1.0': {}
  esbuild@0.27.7: {}
  fsevents@2.3.3:
    os: [darwin]
  msgpackr-extract@3.0.3: {}
  node-pty@1.1.0: {}
  '@swc/core-linux-x64-gnu@1.13.5':
    cpu: [x64]
    os: [linux]
YAML

# Disappeared fixture: the non-defensive denied family `esbuild` lost its
# lifecycle-built main package (only the gated @esbuild/* prebuilts remain),
# which must trip the missing-policy-package check.
missing_lock="$tmp_dir/missing.yaml"
cat >"$missing_lock" <<'YAML'
lockfileVersion: '9.0'
packages:
  '@rollup/rollup-linux-x64-gnu@4.60.2':
    cpu: [x64]
    os: [linux]
  '@esbuild/linux-x64@0.27.7':
    cpu: [x64]
    os: [linux]
  '@opentui/core-linux-x64@0.4.1':
    cpu: [x64]
    os: [linux]
  '@parcel/watcher@2.5.1': {}
  '@myobie/pty@0.1.0': {}
  fsevents@2.3.3:
    os: [darwin]
  msgpackr-extract@3.0.3: {}
  node-pty@1.1.0: {}
YAML

echo "Test 1: clean lockfile passes (exit 0)"
if ! run_bun "$AUDIT" "$clean_lock" >"$tmp_dir/clean.out" 2>&1; then
  echo "FAIL: expected clean fixture to pass" >&2
  cat "$tmp_dir/clean.out" >&2
  exit 1
fi

echo "Test 2: unclassified native family fails (nonzero) and names the offender"
set +e
run_bun "$AUDIT" "$dirty_lock" >"$tmp_dir/dirty.out" 2>&1
dirty_exit=$?
set -e
if [ "$dirty_exit" -eq 0 ]; then
  echo "FAIL: expected unclassified @swc/core family to fail the audit" >&2
  cat "$tmp_dir/dirty.out" >&2
  exit 1
fi
if ! grep -q "@swc/core-linux-x64-gnu" "$tmp_dir/dirty.out"; then
  echo "FAIL: audit output did not name the offending @swc/core family" >&2
  cat "$tmp_dir/dirty.out" >&2
  exit 1
fi

echo "Test 3: disappeared denied family fails (nonzero) and names the offender"
set +e
run_bun "$AUDIT" "$missing_lock" >"$tmp_dir/missing.out" 2>&1
missing_exit=$?
set -e
if [ "$missing_exit" -eq 0 ]; then
  echo "FAIL: expected a disappeared denied family to fail the audit" >&2
  cat "$tmp_dir/missing.out" >&2
  exit 1
fi
if ! grep -qE "missing-policy-package\] esbuild" "$tmp_dir/missing.out"; then
  echo "FAIL: audit output did not flag the missing esbuild family" >&2
  cat "$tmp_dir/missing.out" >&2
  exit 1
fi

echo "Test 4: real repo lockfile passes against the live policy (exit 0)"
if ! run_bun "$AUDIT" "$ROOT/pnpm-lock.yaml" >"$tmp_dir/real.out" 2>&1; then
  echo "FAIL: live pnpm-lock.yaml must satisfy nativeDependencyPolicy" >&2
  cat "$tmp_dir/real.out" >&2
  exit 1
fi

echo ""
echo "native-dep-policy-audit tests passed"
