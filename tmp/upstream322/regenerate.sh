#!/usr/bin/env bash
set -euo pipefail
# Required owner generation only; no unit or browser test tasks.
mr apply --worktree-mode commit
nix run .#genie -- --defer-validation --phase bootstrap
git add packages/@overeng/{effect-automerge,effect-iroh-browser,effect-iroh-automerge,game-laws}/{BUCK,package.json,tsconfig.json}
devenv tasks run buck2:editor:bootstrap
devenv tasks run pnpm:update
