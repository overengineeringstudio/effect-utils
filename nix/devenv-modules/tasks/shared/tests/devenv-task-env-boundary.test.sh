#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
TASK_BLOCK="$(sed -n '/tasks\."test:buck2-tools"\.description/,/^  );/p' "$ROOT/devenv.nix")"

if grep -q 'tasks\."test:buck2-tools"\.env' <<< "$TASK_BLOCK"; then
  echo "FAIL: test:buck2-tools stores derivation paths in task env" >&2
  exit 1
fi

for variable in CP_BIN MV_BIN FALSE_BIN; do
  if ! grep -q "export $variable=" <<< "$TASK_BLOCK"; then
    echo "FAIL: test:buck2-tools exec does not realize $variable lazily" >&2
    exit 1
  fi
done

echo "Devenv task environment boundary tests passed."
