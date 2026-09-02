#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ ! -e "$ROOT/buck2/rust/demo_toolchains.bzl" ] ||
  fail "dead Prelude demo toolchain projection still exists"

buck_sources=()
while IFS= read -r -d '' source; do
  buck_sources+=("$source")
done < <(
  find "$ROOT" \
    -type d \( \
      -name .devenv -o -name .git -o -name buck-out -o -name node_modules -o \
      -name target -o -path "$ROOT/context" -o -path "$ROOT/tmp" \
    \) -prune -o \
    -type f \( -name BUCK -o -name TARGETS -o -name '*.bzl' -o -name '*.bxl' \) \
    -print0
)

[ "${#buck_sources[@]}" -gt 0 ] || fail "Buck source inventory is empty"

if grep -Ein \
  '(^|[^[:alnum:]_])(cpython|python([0-9]+([.][0-9]+)*)?|python_(binary|library|test|toolchain|wheel)|remote_python_toolchain|system_python_wheel_toolchain)([^[:alnum:]_]|$)' \
  "${buck_sources[@]}"; then
  fail "Buck graph still contains a Python action, interpreter, or toolchain edge"
fi

for projection in \
  "$ROOT/buck2-member.json" \
  "$ROOT/buck2-member.json.genie.ts" \
  "$ROOT/devenv.nix" \
  "$ROOT/flake.nix" \
  "$ROOT"/nix/*buck2*.nix \
  "$ROOT"/scripts/buck2*.sh; do
  [ -f "$projection" ] || continue
  if grep -Ein 'cpython|python[^[:alnum:]]*(bootstrap|capability|live[-_ ]?origin|toolchain)' "$projection"; then
    fail "Buck capability projection still contains a CPython bootstrap edge"
  fi
done

echo "Buck Prelude Python absence tests passed."
