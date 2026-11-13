#!/usr/bin/env bash
set -euo pipefail
# Watcher observation requires the same daemon across source edits; this fixture
# owns its shutdown without changing the gate class or physical cgroup.
export BUCK2_GATE_WRAPPER_ACTIVE=1

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)}"
# Buck's Rust client honors WATCHMAN_SOCK; the standalone CLI needs --sockname.
# Resolve without exporting: Buck must still recognize and start its managed service.
watchman_socket="$("${BUN_BIN:-bun}" -e '
  const { prepareWatchmanEnvironment } = await import(process.argv[1])
  prepareWatchmanEnvironment(process.env)
  process.stdout.write(process.env.WATCHMAN_SOCK)
' "$repo_root/scripts/buck2-file-watcher.ts")"
watchman_args=(--no-spawn --no-local "--sockname=$watchman_socket")
work="$(mktemp -d)"
cleanup() {
  (cd "$work" && buck2 --isolation-dir file-watcher-contract kill >/dev/null 2>&1) || true
  watchman "${watchman_args[@]}" watch-del "$work" >/dev/null 2>&1 || true
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
daemon_pid="$(buck2 --isolation-dir file-watcher-contract status | jq -er '.process_info.pid')"
# Verify OS-level pruning, not merely Buck's event filtering after registration.
ignored="$(jq -cn --arg root "$work" \
  '["query",$root,{"fields":["name"],"expression":["anyof",["dirname","buck-out"],["dirname",".devenv"]]}]' \
  | watchman "${watchman_args[@]}" --json-command --output-encoding=json)"
printf '%s\n' "$ignored" | jq -e 'has("error") | not' >/dev/null
printf '%s\n' "$ignored" | jq -e '.files == []' >/dev/null

cat > "$work/BUCK" <<'BUCK'
load("@prelude//:prelude.bzl", "native")
native.export_file(name = "after", src = "payload.txt")
BUCK
[[ "$(buck2 --isolation-dir file-watcher-contract targets //:)" == 'effect_utils//:after' ]]
[[ "$(buck2 --isolation-dir file-watcher-contract status | jq -er '.process_info.pid')" == "$daemon_pid" ]]
echo 'Buck file watcher excludes build outputs and observes source edits'
