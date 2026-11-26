#!/usr/bin/env bash
set -euo pipefail
# Required owner generation only; no unit or browser test tasks.
mr apply --worktree-mode commit
nix run .#genie -- --defer-validation
devenv tasks run pnpm:update
