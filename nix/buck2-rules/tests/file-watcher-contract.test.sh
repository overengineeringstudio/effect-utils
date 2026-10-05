#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)}"
work="$(mktemp -d)"
cleanup() {
  (cd "$work" && buck2 --isolation-dir file-watcher-contract kill >/dev/null 2>&1) || true
  watchman watch-del "$work" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

cp "$repo_root/.buckconfig" "$repo_root/.buckroot" "$repo_root/.watchmanconfig" "$work/"
mkdir -p "$work/.buck2/capabilities" "$work/buck-out/dependency-tree" "$work/.devenv"
printf 'ignored build output\n' > "$work/buck-out/dependency-tree/output.txt"
printf 'ignored shell state\n' > "$work/.devenv/state.txt"
# notify follows dependency symlinks even inside ignored build outputs.
ln -s "$work" "$work/buck-out/dependency-tree/recursive-dependency"
printf 'source payload\n' > "$work/payload.txt"
cat > "$work/BUCK" <<'BUCK'
load("@prelude//:prelude.bzl", "native")
native.export_file(name = "before", src = "payload.txt")
BUCK

cd "$work"
[[ "$(buck2 --isolation-dir file-watcher-contract targets //:)" == 'effect_utils//:before' ]]
# Verify OS-level pruning, not merely Buck's event filtering after registration.
ignored="$(jq -cn --arg root "$work" \
  '["query",$root,{"fields":["name"],"expression":["anyof",["dirname","buck-out"],["dirname",".devenv"]]}]' \
  | watchman --json-command --output-encoding=json)"
printf '%s\n' "$ignored" | jq -e 'has("error") | not' >/dev/null
printf '%s\n' "$ignored" | jq -e '.files == []' >/dev/null

cat > "$work/BUCK" <<'BUCK'
load("@prelude//:prelude.bzl", "native")
native.export_file(name = "after", src = "payload.txt")
BUCK
[[ "$(buck2 --isolation-dir file-watcher-contract targets //:)" == 'effect_utils//:after' ]]
echo 'Buck file watcher excludes build outputs and observes source edits'
