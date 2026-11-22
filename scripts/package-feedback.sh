#!/usr/bin/env bash
# Fast source feedback, not a replacement for the authoritative Buck/check:quick gate.
set -euo pipefail
if [[ $# != 1 ]]; then
  printf 'Usage: bash scripts/package-feedback.sh PACKAGE_DIRECTORY\n' >&2
  exit 2
fi
cd "$1"
# The caller supplies the pinned toolchain; never realize a shell implicitly.
export DEVENV_TASK_PASSTHROUGH=1
oxlint src
tsgo --build
# Bun is required by bun:sqlite and subprocess/socket integration coverage.
# Keep the complete Vitest inventory: --changed may silently select no tests.
exec bun run --bun node_modules/vitest/vitest.mjs run
