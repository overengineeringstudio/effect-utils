#!/usr/bin/env bash
set -euo pipefail
test "$(df -B1 --output=avail / | tail -1)" -ge 120000000000 || exit 94
# Required owner generation only; no unit or browser test tasks.
mr apply --worktree-mode commit
nix run .#genie -- --defer-validation --phase bootstrap
git add packages/@overeng/{effect-automerge,effect-iroh-browser,effect-iroh-automerge,game-laws}/{BUCK,package.json,tsconfig.json}
devenv tasks run buck2:editor:bootstrap
devenv tasks run content-address:contract:generate
devenv tasks run pnpm:update
