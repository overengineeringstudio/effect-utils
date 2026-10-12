#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
# Retain fixtures for inspection: the collector's default contract is no deletion.
fixture="$(mktemp -d "${TMPDIR:-/tmp}/pnpm-store-gc-test.XXXXXXXX")"
export PNPM_GC_TEST_ROOT="$fixture"
export XDG_STATE_HOME="$fixture/state"
"${RUSTC_BIN:-rustc}" --edition=2024 -D warnings --test \
  "$ROOT/nix/devenv-modules/tasks/shared/pnpm-store-gc.rs" -o "$fixture/tests"
"$fixture/tests"
"${RUSTC_BIN:-rustc}" --edition=2024 -D warnings \
  "$ROOT/nix/devenv-modules/tasks/shared/pnpm-store-gc.rs" -o "$fixture/engine"
git init --bare -q "$fixture/repo.git"
store="$fixture/retired-root/.devenv/pnpm-store-pure-v1"
mkdir -p "$store/v11/files"
printf 'preserve\n' > "$store/v11/files/sentinel"
"$fixture/engine" --git-dir "$fixture/repo.git" --root "$fixture/retired-root" --observe
test -f "$store/.effect-utils-pnpm-store-cache-maintenance.lock"
test "$(cat "$store/v11/files/sentinel")" = preserve
if flock --shared "$store/.effect-utils-pnpm-store-cache-maintenance.lock" \
  "$fixture/engine" --git-dir "$fixture/repo.git" --root "$fixture/retired-root" --observe; then
  echo "FAIL: observer entered while a consumer held the shared maintenance lease" >&2
  exit 1
fi
if "$fixture/engine" --locked --git-dir "$fixture/repo.git" --root "$fixture/retired-root" --observe; then
  echo "FAIL: observer accepted an unproved inherited lease" >&2
  exit 1
fi
test "$(cat "$store/v11/files/sentinel")" = preserve
echo "PASS: real exclusive lease admission, shared-consumer exclusion, and inherited-lease proof; no payloads deleted"
printf 'pnpm-store-gc fixtures retained at %s\n' "$fixture"
