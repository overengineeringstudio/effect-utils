#!/usr/bin/env bash
set -euo pipefail
compiler="${1:?expected the real Buck compiler wrapper}"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

rejects() {
  if EFFECT_UTILS_RUST_PANIC=unwind "$compiler" "$@" -vV >"$work/output" 2>&1; then
    echo "Compiler accepted a conflicting panic strategy: $*" >&2
    exit 1
  fi
  grep -F 'is not allowed: toolchain panic=unwind' "$work/output"
}

rejects -Cpanic=abort
rejects -C panic=abort
rejects --codegen=panic=abort
rejects --codegen panic=abort
printf '%s\n' '-C' 'panic=abort' >"$work/args"
rejects "@$work/args"
printf '@%s\n' "$work/args" >"$work/nested"
rejects "@$work/nested"
EFFECT_UTILS_RUST_PANIC=unwind "$compiler" -Cpanic=unwind -vV >"$work/output"
EFFECT_UTILS_RUST_PANIC=abort "$compiler" -Cpanic=abort -vV >"$work/output"
echo 'Compiler panic guard argv/response tests passed.'
