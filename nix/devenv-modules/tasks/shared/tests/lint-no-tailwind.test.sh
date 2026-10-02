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

# Inert archives are outside the source surface, not permitted active Tailwind.
mkdir -p "$tmpdir/scoped/archive/retired" "$tmpdir/scoped/archive-active" "$tmpdir/scoped/apps/live"
git -C "$tmpdir/scoped" init --quiet
printf '{"dependencies":{"tailwindcss":"4"}}\n' > "$tmpdir/scoped/archive/retired/package.json"
git -C "$tmpdir/scoped" add archive
printf '@import "tailwindcss";\n' > "$tmpdir/scoped/archive/retired/site.css"
if (cd "$tmpdir/scoped" && node "$tmpdir/guard.mjs") 2>"$tmpdir/default-violations"; then
  echo "The default scanner silently excluded an archive" >&2
  exit 1
fi
grep -q 'archive/retired/package.json:1:' "$tmpdir/default-violations"
grep -q 'archive/retired/site.css:1:' "$tmpdir/default-violations"
test "$(cd "$tmpdir/scoped" && node "$tmpdir/guard.mjs" . ':(exclude)archive/**')" = "No unexcepted Tailwind usage"

# A similarly named active directory must not be swallowed by the exclusion.
printf '{"devDependencies":{"@tailwindcss/vite":"4"}}\n' > "$tmpdir/scoped/apps/live/package.json"
git -C "$tmpdir/scoped" add apps
printf 'import tailwind from "@tailwindcss/vite"\n' > "$tmpdir/scoped/apps/live/vite.config.ts"
printf '@apply flex;\n' > "$tmpdir/scoped/archive-active/site.css"
if (cd "$tmpdir/scoped" && node "$tmpdir/guard.mjs" . ':(exclude)archive/**') 2>"$tmpdir/scoped-violations"; then
  echo "The source-scoped scanner accepted active Tailwind" >&2
  exit 1
fi
grep -q 'apps/live/package.json:1:' "$tmpdir/scoped-violations"
grep -q 'apps/live/vite.config.ts:1:' "$tmpdir/scoped-violations"
grep -q 'archive-active/site.css:1:' "$tmpdir/scoped-violations"
if grep -q 'archive/retired/' "$tmpdir/scoped-violations"; then
  echo "The source-scoped scanner linted inert archived files" >&2
  exit 1
fi
