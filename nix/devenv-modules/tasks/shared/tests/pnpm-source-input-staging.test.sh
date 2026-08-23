#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stager="$script_dir/../stage-pnpm-source-inputs.mjs"
staging_fs="$script_dir/../source-input-staging-fs.mjs"
tmpdir="$(mktemp -d)"
trap 'chmod -R u+w "$tmpdir" 2>/dev/null || true; rm -rf "$tmpdir"' EXIT

workspace="$tmpdir/workspace"
outside="$tmpdir/outside"
mkdir -p "$workspace/repos/demo/packages/pkg/src" "$outside"
printf 'one\n' > "$workspace/repos/demo/packages/pkg/src/value.txt"

node "$stager" publish "$workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg
node "$stager" check "$workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg
node "$stager" publish "$workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg
[ "$(find "$workspace/.devenv/pnpm-source-inputs/generations" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1 ]
staged="$workspace/.devenv/pnpm-source-inputs/current/repos/demo/packages/pkg/src/value.txt"
cmp "$workspace/repos/demo/packages/pkg/src/value.txt" "$staged"

chmod u+w "$staged"
printf 'staged mutation\n' > "$staged"
grep -qxF one "$workspace/repos/demo/packages/pkg/src/value.txt"
if node "$stager" check "$workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg 2>/dev/null; then
  echo "FAIL: staged drift was accepted" >&2
  exit 1
fi

printf 'two\n' > "$workspace/repos/demo/packages/pkg/src/value.txt"
chmod 0744 "$workspace/repos/demo/packages/pkg/src/value.txt"
node "$stager" publish "$workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg
grep -qxF two "$staged"
node "$stager" check "$workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg
[ -x "$staged" ]
mkdir -p "$workspace/node_modules/pkg/src"
installed="$workspace/node_modules/pkg/src/value.txt"
ln "$staged" "$installed"
printf 'three\n' > "$workspace/repos/demo/packages/pkg/src/value.txt"
node "$stager" publish "$workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg
node "$stager" gc "$workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg
[ "$(find "$workspace/.devenv/pnpm-source-inputs/generations" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1 ]
grep -qxF two "$installed"
[ -x "$installed" ]

if node "$stager" publish "$workspace" .devenv/pnpm-source-inputs ../outside 2>/dev/null; then
  echo "FAIL: parent traversal source was accepted" >&2
  exit 1
fi

chmod -R u+w "$workspace/.devenv/pnpm-source-inputs"
rm -rf "$workspace/.devenv/pnpm-source-inputs"
ln -s "$outside" "$workspace/.devenv/pnpm-source-inputs"
printf 'sentinel\n' > "$outside/sentinel"
if node "$stager" publish "$workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg 2>/dev/null; then
  echo "FAIL: symlinked staging root was accepted" >&2
  exit 1
fi
grep -qxF sentinel "$outside/sentinel"

mkdir -p "$workspace/.devenv/source"
if node "$stager" publish "$workspace" .devenv/pnpm-source-inputs .devenv 2>/dev/null; then
  echo "FAIL: source overlapping staging state was accepted" >&2
  exit 1
fi

rm "$workspace/.devenv/pnpm-source-inputs"
ln -s "$outside/sentinel" "$workspace/repos/demo/packages/pkg/src/escape"
if node "$stager" publish "$workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg 2>/dev/null; then
  echo "FAIL: escaping source symlink was accepted" >&2
  exit 1
fi
grep -qxF sentinel "$outside/sentinel"

rm "$workspace/repos/demo/packages/pkg/src/escape"
mkdir "$workspace/repos/demo/packages/pkg/linked-dir"
ln -s ../linked-dir "$workspace/repos/demo/packages/pkg/src/directory-link"
if node "$stager" publish "$workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg 2>/dev/null; then
  echo "FAIL: source directory symlink was accepted" >&2
  exit 1
fi

rm "$workspace/repos/demo/packages/pkg/src/directory-link"
ln -s . "$workspace/repos/demo/packages/pkg/src/loop"
if node "$stager" publish "$workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg 2>/dev/null; then
  echo "FAIL: directory symlink cycle was accepted" >&2
  exit 1
fi

cleanup_workspace="$tmpdir/cleanup-workspace"
mkdir -p \
  "$cleanup_workspace/repos/demo/packages/pkg" \
  "$cleanup_workspace/.devenv/pnpm-source-inputs/generations"
printf 'cleanup\n' > "$cleanup_workspace/repos/demo/packages/pkg/value.txt"
chmod 0555 "$cleanup_workspace/.devenv/pnpm-source-inputs"
if node "$stager" publish "$cleanup_workspace" .devenv/pnpm-source-inputs repos/demo/packages/pkg 2>/dev/null; then
  echo "FAIL: publishing through an unwritable pointer root unexpectedly succeeded" >&2
  exit 1
fi
if find "$cleanup_workspace/.devenv/pnpm-source-inputs/generations" \
  -mindepth 1 -maxdepth 1 | grep -q .; then
  echo "FAIL: failed publication retained a partial read-only generation" >&2
  exit 1
fi

node --input-type=module - "$staging_fs" <<'JS'
import assert from 'node:assert/strict'

const { removeStagingTree } = await import(process.argv[2])
const calls = []
const fs = {
  stat: async () => ({ mode: 0o551 }),
  chmod: async (path, mode) => calls.push(['chmod', path, mode]),
  readdir: async () => [],
  rm: async (path, options) => calls.push(['rm', path, options]),
}
await removeStagingTree('/fixture/.next-generation', fs)
assert.deepEqual(calls, [
  ['chmod', '/fixture/.next-generation', 0o751],
  ['rm', '/fixture/.next-generation', { force: true, recursive: true }],
])
JS

echo "pnpm source input staging tests passed"
