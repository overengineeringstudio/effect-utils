#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
bun_bin="${2:-${BUN_BIN:-bun}}"
runner="${3:-${WORKSPACE_CONTRACT_RUNNER:-$repo_root/packages/@overeng/buck2-tools/src/repository-validation-runner.ts}}"
output="${4:-${WORKSPACE_CONTRACT_OUTPUT:-$repo_root/tmp/workspace-contract.json}}"
manifest="${5:-${WORKSPACE_CONTRACT_MANIFEST:-}}"
extra_args=("${@:6}")

if [ -z "$manifest" ]; then
  echo "workspace-contract: WORKSPACE_CONTRACT_MANIFEST or a fifth argument is required" >&2
  exit 1
fi

exec "$bun_bin" "$runner" \
  --mode workspace-contract \
  --source "$repo_root" \
  --output "$output" \
  --manifest "$manifest" \
  "${extra_args[@]}"
