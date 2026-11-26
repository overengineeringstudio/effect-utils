#!/usr/bin/env bash
set -euo pipefail
# Generation prerequisite only: no unit, browser, or screenshot tasks.
mr apply --worktree-mode commit
nix run .#genie -- --defer-validation
devenv tasks run pnpm:update
