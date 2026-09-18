#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
stage_zero="$ROOT/nix/buck2-stage0-tools.nix"
bootstrap="$ROOT/nix/devenv-modules/tasks/shared/bootstrap-closure.nix"
devenv="$ROOT/devenv.nix"

if grep -q 'root = repositoryRoot' "$stage_zero"; then
  echo "FAIL: Buck stage-zero source coercion still registers the repository root" >&2
  exit 1
fi
grep -q 'root = workspaceRoot' "$stage_zero" || {
  echo "FAIL: Buck stage-zero source does not use the narrow Rust workspace root" >&2
  exit 1
}
if grep -q 'builtins\.path' "$bootstrap"; then
  echo "FAIL: bootstrap-closure task still coerces the effect-utils repository root" >&2
  exit 1
fi
workflow_report="$(sed -n '/taskModules\.workflow-report {/,/})/p' "$devenv")"
if [[ "$workflow_report" != *'ciToolsBin = "${ciToolsCli}/bin/ci-tools";'* ]]; then
  echo "FAIL: workflow-report task still forces its repository-root source fallback" >&2
  exit 1
fi

echo "Devenv eval source-root tests passed."
