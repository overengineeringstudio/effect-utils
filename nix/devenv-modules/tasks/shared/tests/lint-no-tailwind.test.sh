#!/usr/bin/env bash
set -euo pipefail

node --test scripts/lint-no-tailwind.unit.test.mjs
node scripts/lint-no-tailwind.mjs

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
ln -s "$PWD/scripts/lint-no-tailwind.mjs" "$tmpdir/guard.mjs"
# Consumer workspaces invoke the published scanner through symlinked members.
test "$(node "$tmpdir/guard.mjs")" = "No unexcepted Tailwind usage"
