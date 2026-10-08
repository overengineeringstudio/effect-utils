#!/usr/bin/env bash
set -euo pipefail
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd -P)"
BUN="${BUN_BIN:-$(command -v bun)}"
BUCK2="${BUCK2_BIN:-$(command -v buck2)}"
DEVENV="${DEVENV_BIN:-$(command -v devenv)}"
FINGERPRINT="${FINGERPRINT_BIN:?FINGERPRINT_BIN must name the pinned fingerprint tool}"
CP="${CP_BIN:?CP_BIN must name pinned cp}"
MV="${MV_BIN:?MV_BIN must name pinned mv}"
TEMP_ROOT="$(mktemp -d)"
TEMP_ROOT="$(cd "$TEMP_ROOT" && pwd -P)"
main="$TEMP_ROOT/main"
worktree="$TEMP_ROOT/retired"
socket_dir=""
watchman_started=false
cleanup() {
  local result=$?
  if [ -d "$worktree" ]; then
    for isolation in first .second; do
      (cd "$worktree" && "$BUCK2" --isolation-dir "$isolation" kill) >/dev/null 2>&1 || true
    done
    find -P "$worktree" -type d -exec chmod u+w -- {} +
    git -C "$main" worktree remove --force "$worktree" >/dev/null 2>&1 || true
  fi
  if [ "$watchman_started" = true ]; then
    watchman --sockname="$WATCHMAN_SOCK" --no-spawn --no-local shutdown-server >/dev/null
  fi
  [ -z "$socket_dir" ] || rm -rf "$socket_dir"
  rm -rf "$TEMP_ROOT"
  exit "$result"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
mkdir -p "$main"
git -C "$main" init -q
printf '.devenv/\n.editor-view/\nnode_modules\n.buckconfig.local\nbuck-out/\ninputs/\nreadonly/\nexternal-link\ndevenv.lock\n' >"$main/.gitignore"
printf '{}\n' >"$main/package.json"
touch "$main/.buckroot"
# Parsing an empty package starts a genuine daemon without build inputs/network.
touch "$main/BUCK"
cat >"$main/.buckconfig" <<'CONFIG'
[cells]
  root = .
  prelude = prelude
[cell_aliases]
  config = prelude
  ovr_config = prelude
  fbsource = prelude
  toolchains = root
[external_cells]
  prelude = bundled
[buck2]
  file_watcher = notify
  remote_cache_enabled = false
CONFIG
printf '{"ignore_dirs":["buck-out"]}\n' >"$main/.watchmanconfig"
cat >"$main/devenv.yaml" <<'YAML'
inputs:
  devenv:
    url: github:cachix/devenv/v2.4.0
  nixpkgs:
    url: github:NixOS/nixpkgs/nixos-unstable
  git-hooks:
    url: github:cachix/git-hooks.nix
    inputs:
      nixpkgs:
        follows: nixpkgs
YAML
cat >"$main/devenv.nix" <<NIX
{ pkgs, ... }: {
  imports = [ (import $ROOT/nix/devenv-modules/tasks/shared/setup.nix { runOnEnterShell = false; }) ];
  cachix.enable = false;
  tasks."buck2:editor:release".exec = ''
    $BUN $ROOT/packages/@overeng/buck2-tools/src/editor-view.ts release --repo-root "\$DEVENV_ROOT" --package .
  '';
}
NIX
git -C "$main" add .
# Fixture commits must not execute the operator's ambient policy hooks.
git -C "$main" -c core.hooksPath=/dev/null -c user.name=teardown-test -c user.email=teardown-test@example.invalid commit -qm fixture
git -C "$main" worktree add -q --detach "$worktree" HEAD
cp "$ROOT/devenv.lock" "$worktree/devenv.lock"

# Real byte-owning editor publication, not hand-built snapshot metadata.
mkdir -p "$worktree/inputs/editor" "$worktree/inputs/modules/dep"
printf '{}\n' >"$worktree/inputs/editor/install-descriptor.json"
printf 'export default 1\n' >"$worktree/inputs/modules/dep/index.js"
printf '{"schema":"effect-utils/workspace-dependency-authority/v1","requiredPackages":["."],"ownedPackages":["."]}\n' >"$worktree/inputs/authority.json"
"$BUN" "$ROOT/packages/@overeng/buck2-tools/src/editor-view.ts" publish \
  --repo-root "$worktree" --package . --view-name root --cell root --target //:editor_inputs \
  --editor-inputs "$worktree/inputs/editor" --node-modules "$worktree/inputs/modules" \
  --workspace-authority "$worktree/inputs/authority.json" --consumer-cache "$worktree/.devenv/vite-cache/root" \
  --cp "$CP" --mv "$MV" --fingerprint-tool "$FINGERPRINT" --snapshot-retention 2
[ -d "$worktree/.editor-view/.store" ] || fail 'real editor view was not published'

export XDG_CACHE_HOME="$TEMP_ROOT/cache"
cache="$XDG_CACHE_HOME/effect-utils/buck2-posture-v2"
mkdir -p "$cache"
root_hash="$(printf %s "$worktree" | sha256sum)"; root_hash="${root_hash%% *}"
if command -v watchman >/dev/null 2>&1; then
  socket_dir="$(mktemp -d /tmp/wt-watch.XXXXXX)"
  export WATCHMAN_SOCK="$socket_dir/w.sock" WATCHMAN_CONFIG_FILE="$TEMP_ROOT/watchman.config"
  printf '{"min_acceptable_nice_value":19}\n' >"$WATCHMAN_CONFIG_FILE"
  watchman_started=true
  watchman --no-site-spawner --sockname="$WATCHMAN_SOCK" --statefile="$TEMP_ROOT/w.state" \
    --logfile="$TEMP_ROOT/w.log" --pidfile="$TEMP_ROOT/w.pid" --no-local version >/dev/null
  watchman --sockname="$WATCHMAN_SOCK" --no-spawn --no-local watch "$worktree" >/dev/null
  printf '\n[buck2]\nfile_watcher = watchman\n' >"$worktree/.buckconfig.local"
  # Production admission writes an actual root-keyed entry.
  "$BUN" -e 'const {directBuckArguments}=await import(process.argv[1]); await directBuckArguments({args:["targets","//:"],cwd:process.argv[2],env:process.env})' \
    "$ROOT/scripts/buck2-entrypoint.ts" "$worktree"
  compgen -G "$cache/$root_hash-*.json" >/dev/null || fail 'production admission did not write a root-keyed entry'
else
  printf '{}\n' >"$cache/$root_hash-fixture.json"
fi
# Cover other environment variants, interrupted writes, and unrelated shared state.
printf '{}\n' >"$cache/$root_hash-other.json.pending"
printf 'other-root\n' >"$cache/other-root.json"
printf 'endpoint\n' >"$cache/endpoint.json"
state="$HOME/.buck/buckd/${worktree#/}"
declare -a pids=()
for isolation in first .second; do
  (cd "$worktree" && "$BUCK2" --isolation-dir "$isolation" targets //: >/dev/null)
  pid="$(cat "$state/$isolation/buckd.pid")"
  kill -0 "$pid" || fail 'fixture daemon is not live'
  pids+=("$pid")
done
mkdir -p "$worktree/readonly/nested" "$TEMP_ROOT/external"
printf 'immutable\n' >"$worktree/readonly/nested/file"
chmod 444 "$worktree/readonly/nested/file"
chmod 555 "$worktree/readonly" "$worktree/readonly/nested" "$TEMP_ROOT/external"
ln -s "$TEMP_ROOT/external" "$worktree/external-link"

# Execute the inherited task through devenv, including its real nested release.
(cd "$worktree" && "$DEVENV" tasks run worktree:teardown --mode single)
for pid in "${pids[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then fail "daemon $pid remains live"; fi
done
[ ! -e "$state" ] || fail 'root buckd state remains'
[ ! -e "$worktree/.editor-view" ] || fail 'editor roots remain'
if compgen -G "$cache/$root_hash-*" >/dev/null; then fail 'root admission entries remain'; fi
[ "$(cat "$cache/other-root.json")" = other-root ] || fail 'unrelated root cache changed'
[ "$(cat "$cache/endpoint.json")" = endpoint ] || fail 'shared endpoint cache changed'
"$BUN" -e 'const fs=require("node:fs"); if ((fs.statSync(process.argv[1]).mode & 0o777) !== 0o444 || (fs.statSync(process.argv[2]).mode & 0o777) !== 0o555) process.exit(1)' \
  "$worktree/readonly/nested/file" "$TEMP_ROOT/external" || fail 'teardown changed a file mode or followed a symlink'
if [ "$watchman_started" = true ]; then
  watchman --sockname="$WATCHMAN_SOCK" --no-spawn --no-local watch-list | \
    jq -e --arg root "$worktree" '.roots | index($root) == null' >/dev/null || fail 'watch remains'
fi
(cd "$worktree" && "$DEVENV" tasks run worktree:teardown --mode single)
# Also prove an unreachable Watchman remains a successful no-op.
(cd "$worktree" && WATCHMAN_SOCK="$TEMP_ROOT/missing.sock" "$DEVENV" tasks run worktree:teardown --mode single)
git -C "$main" worktree remove "$worktree"
[ ! -e "$worktree" ] || fail 'ordinary git worktree remove failed'
echo 'PASS: two live Buck isolations stopped; buckd/watch/root caches/editor roots released; second and unreachable-Watchman runs exit 0; unrelated state and file modes preserved; git worktree remove succeeds without chmod'
