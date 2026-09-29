#!/usr/bin/env bash
set -euo pipefail

node --test scripts/lint-no-tailwind.unit.test.mjs
node scripts/lint-no-tailwind.mjs

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
ln -s "$PWD/scripts/lint-no-tailwind.mjs" "$tmpdir/guard.mjs"
# Consumer workspaces invoke the published scanner through symlinked members.
test "$(node "$tmpdir/guard.mjs")" = "No unexcepted Tailwind usage"

# The published CLI reads exceptions from the consumer tree, not from Nix arguments.
mkdir "$tmpdir/consumer"
git -C "$tmpdir/consumer" init --quiet
printf '{"dependencies":{"tailwindcss":"4"}}\n' > "$tmpdir/consumer/package.json"
if (cd "$tmpdir/consumer" && node "$tmpdir/guard.mjs") 2>"$tmpdir/violations"; then
  echo "The scanner accepted Tailwind without an exception" >&2
  exit 1
fi
grep -q 'package.json:1:' "$tmpdir/violations"
printf '[{"path":"**","reason":"Existing application pending migration"}]\n' > "$tmpdir/consumer/.no-tailwind-exceptions.json"
test "$(cd "$tmpdir/consumer" && node "$tmpdir/guard.mjs")" = "No unexcepted Tailwind usage"
