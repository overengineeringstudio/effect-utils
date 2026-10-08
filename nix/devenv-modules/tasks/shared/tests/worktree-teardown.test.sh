#!/usr/bin/env bash
set -euo pipefail
# Keep command diagnostics in the aggregate runner's captured test stream.
exec 2>&1
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd -P)"
BUN="${BUN_BIN:-$(command -v bun)}"
BUCK2="${BUCK2_BIN:-$(command -v buck2)}"
DEVENV="${DEVENV_BIN:-$(command -v devenv)}"
FINGERPRINT="${FINGERPRINT_BIN:?FINGERPRINT_BIN must name the pinned fingerprint tool}"
CP="${CP_BIN:?CP_BIN must name pinned cp}"
MV="${MV_BIN:?MV_BIN must name pinned mv}"
JQ="${JQ_BIN:-$(command -v jq)}"
TEMP_ROOT="$(mktemp -d)"
TEMP_ROOT="$(cd "$TEMP_ROOT" && pwd -P)"
main="$TEMP_ROOT/main"
worktree="$TEMP_ROOT/retired"
socket_dir=""
watchman_started=false
nested_outer=""
nested_child=""
descendant_state=""
collision_started=false
cleanup() {
  local result=$?
  if [ -n "$descendant_state" ]; then rm -rf -- "$descendant_state"; fi
  if [ -n "$nested_outer" ] && [ -d "$nested_outer" ]; then
    if [ -d "$nested_child" ]; then
      (cd "$nested_child" && "$BUCK2" --isolation-dir child kill) >/dev/null 2>&1 || true
    fi
    (cd "$nested_outer" && "$BUCK2" --isolation-dir outer kill) >/dev/null 2>&1 || true
    if [ "$collision_started" = true ]; then
      (cd "$nested_outer" && "$BUCK2" --isolation-dir nested kill) >/dev/null 2>&1 || true
      # Both daemons above are test-owned and stopped. Remove only the child's
      # known fixture isolation so the parent's ambiguous container can clear.
      rm -rf -- "$child_state/child"
    fi
    for checkout in "$nested_child" "$nested_outer"; do
      if [ -d "$checkout" ]; then
        DEVENV_ROOT="$checkout" WORKTREE_TEARDOWN_EDITOR_RELEASE=0 \
          bash "$ROOT/nix/devenv-modules/tasks/shared/worktree-teardown.sh" >/dev/null 2>&1 || true
      fi
    done
    # These are test-owned fixtures; restore their protected nested directories
    # only after the survival assertions, so failed tests also clean up safely.
    find -P "$nested_outer" -type d -exec chmod u+w -- {} +
    git -C "$main" worktree remove --force "$nested_child" >/dev/null 2>&1 || true
    git -C "$main" worktree remove --force "$nested_outer" >/dev/null 2>&1 || true
  fi
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
printf '.devenv/\n.editor-view/\nnode_modules\n.buckconfig.local\nbuck-out/\ninputs/\nreadonly/\nexternal-link\ndevenv.lock\nnested/\ncheckout/\nrepos/\ncomposition/\nmegarepo.json\n' >"$main/.gitignore"
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
    --logfile="$TEMP_ROOT/w.log" --pidfile="$TEMP_ROOT/w.pid" --no-local version
  watchman --sockname="$WATCHMAN_SOCK" --no-spawn --no-local watch "$worktree"
  printf '\n[buck2]\nfile_watcher = watchman\n' >"$worktree/.buckconfig.local"
  # Production admission writes an actual root-keyed entry.
  "$BUN" -e 'const {directBuckArguments}=await import(process.argv[1]); await directBuckArguments({args:["targets","//:"],cwd:process.argv[2],env:process.env})' \
    "$ROOT/scripts/buck2-entrypoint.ts" "$worktree"
else
  printf '{}\n' >"$cache/$root_hash-fixture.json"
fi
# bashNonInteractive omits completion builtins such as compgen. Ordinary glob
# expansion still supplies the exact admission filenames for these assertions.
admission_entries=( "$cache/$root_hash-"*.json )
[ -f "${admission_entries[0]}" ] || fail 'production admission did not write a root-keyed entry'
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
# Exercise Buck-owned history cleanup with regular log files, not just emptiness.
printf 'retained daemon log\n' >"$state/first/prev/retained.log"
mkdir -p "$worktree/readonly/nested" "$TEMP_ROOT/external"
printf 'immutable\n' >"$worktree/readonly/nested/file"
chmod 444 "$worktree/readonly/nested/file"
chmod 555 "$worktree/readonly" "$worktree/readonly/nested" "$TEMP_ROOT/external"
ln -s "$TEMP_ROOT/external" "$worktree/external-link"

# Both an escaping and an in-base ancestor symlink must be refused before any
# daemon, watch, cache or directory mutation. Use isolated fake state homes.
attack_home="$TEMP_ROOT/attack-home"
attack_base="$attack_home/.buck/buckd"
mkdir -p "$attack_base/alias" "$TEMP_ROOT/attack-outside"
relative_root="${worktree#/}"
first_component="${relative_root%%/*}"
for target in "$TEMP_ROOT/attack-outside" "$attack_base/alias"; do
  printf 'untouched\n' >"$target/sentinel"
  ln -s "$target" "$attack_base/$first_component"
  if HOME="$attack_home" DEVENV_ROOT="$worktree" WORKTREE_TEARDOWN_EDITOR_RELEASE=0 \
    bash "$ROOT/nix/devenv-modules/tasks/shared/worktree-teardown.sh" \
    >"$TEMP_ROOT/symlink-refusal.log" 2>&1; then
    fail 'teardown accepted a symlinked intermediate state component'
  fi
  cat "$TEMP_ROOT/symlink-refusal.log"
  [ "$(cat "$target/sentinel")" = untouched ] || fail 'symlink target changed'
  rm "$attack_base/$first_component"
done
for pid in "${pids[@]}"; do kill -0 "$pid" || fail 'refused teardown stopped a daemon'; done
[ -f "${admission_entries[0]}" ] || fail 'refused teardown deleted admission state'

# Execute the inherited task through devenv, including its real nested release.
(cd "$worktree" && "$DEVENV" tasks run worktree:teardown --mode single)
for pid in "${pids[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then fail "daemon $pid remains live"; fi
done
[ ! -e "$state" ] || fail 'root buckd state remains'
[ ! -e "$worktree/.editor-view" ] || fail 'editor roots remain'
for entry in "$cache/$root_hash-"*; do
  if [ -e "$entry" ] || [ -L "$entry" ]; then fail 'root admission entries remain'; fi
done
[ "$(cat "$cache/other-root.json")" = other-root ] || fail 'unrelated root cache changed'
[ "$(cat "$cache/endpoint.json")" = endpoint ] || fail 'shared endpoint cache changed'
"$BUN" -e 'const fs=require("node:fs"); if ((fs.statSync(process.argv[1]).mode & 0o777) !== 0o444 || (fs.statSync(process.argv[2]).mode & 0o777) !== 0o555) process.exit(1)' \
  "$worktree/readonly/nested/file" "$TEMP_ROOT/external" || fail 'teardown changed a file mode or followed a symlink'
if [ "$watchman_started" = true ]; then
  watchman --sockname="$WATCHMAN_SOCK" --no-spawn --no-local watch-list | \
    "$JQ" -e --arg root "$worktree" '.roots | index($root) == null' >/dev/null || fail 'watch remains'
fi
(cd "$worktree" && "$DEVENV" tasks run worktree:teardown --mode single)
# Also prove an unreachable Watchman remains a successful no-op.
(cd "$worktree" && WATCHMAN_SOCK="$TEMP_ROOT/missing.sock" "$DEVENV" tasks run worktree:teardown --mode single)
git -C "$main" worktree remove "$worktree"
[ ! -e "$worktree" ] || fail 'ordinary git worktree remove failed'
echo 'PASS: two live Buck isolations stopped; buckd/watch/root caches/editor roots released; second and unreachable-Watchman runs exit 0; unrelated state and file modes preserved; git worktree remove succeeds without chmod'

# A descendant absolute checkout path shares its parent's buckd namespace, but
# is not one of the parent's isolations. Exercise Git file/dir boundaries and
# materialized megarepo members in a separate linked scratch worktree.
nested_outer="$TEMP_ROOT/outer"
nested_child="$nested_outer/nested"
git -C "$main" worktree add -q --detach "$nested_outer" HEAD
git -C "$main" worktree add -q --detach "$nested_child" HEAD
cp "$ROOT/devenv.lock" "$nested_outer/devenv.lock"
git -C "$nested_outer" -c core.hooksPath=/dev/null init -q "$nested_outer/checkout"
mkdir -p "$nested_child/readonly" "$nested_outer/checkout/readonly" \
  "$nested_outer/repos/member/readonly" "$nested_outer/composition/repos/member/readonly"
printf '{}\n' >"$nested_outer/megarepo.json"
touch "$nested_outer/composition/megarepo.kdl"
outer_state="$HOME/.buck/buckd/${nested_outer#/}"
child_state="$outer_state/nested"
(cd "$nested_outer" && "$BUCK2" --isolation-dir outer targets //: >/dev/null)
(cd "$nested_child" && "$BUCK2" --isolation-dir child targets //: >/dev/null)
outer_pid="$(cat "$outer_state/outer/buckd.pid")"
child_pid="$(cat "$child_state/child/buckd.pid")"
kill -0 "$outer_pid" && kill -0 "$child_pid" || fail 'nested fixture daemons are not live'
# A descendant checkout may itself be named like a daemon file. A directory
# with that name must not turn its parent's state container into an isolation.
descendant_state="$child_state/buckd.pid"
mkdir -p "$descendant_state/deeper"
printf 'untouched\n' >"$descendant_state/deeper/sentinel"
protected=(
  "$nested_child" "$nested_child/readonly"
  "$nested_outer/checkout" "$nested_outer/checkout/readonly"
  "$nested_outer/repos" "$nested_outer/repos/member" "$nested_outer/repos/member/readonly"
  "$nested_outer/composition" "$nested_outer/composition/repos/member/readonly"
)
chmod 555 "${protected[@]}"
for iteration in first second; do
  (cd "$nested_outer" && "$DEVENV" tasks run worktree:teardown --mode single)
  if kill -0 "$outer_pid" 2>/dev/null; then fail 'outer daemon remains live'; fi
  [ ! -e "$outer_state/outer" ] || fail 'outer isolation state remains'
  [ -d "$child_state/child" ] || fail 'nested checkout daemon state was removed'
  [ "$(cat "$child_state/child/buckd.pid")" = "$child_pid" ] || fail 'nested daemon state changed'
  kill -0 "$child_pid" || fail 'nested checkout daemon was stopped'
  [ "$(cat "$descendant_state/deeper/sentinel")" = untouched ] || fail 'daemon-file-named descendant state changed'
  "$BUN" -e 'const fs=require("node:fs"); for (const path of process.argv.slice(1)) if ((fs.statSync(path).mode & 0o777) !== 0o555) { console.error(path); process.exit(1) }' \
    "${protected[@]}" || fail 'teardown chmodded a nested checkout or megarepo member'
done
(cd "$nested_child" && "$BUCK2" --isolation-dir child status >/dev/null)
echo 'PASS: nested checkout state and live daemon survive both parent teardowns; Git checkout/worktree and megarepo directory modes remain unchanged; escaping and in-base intermediate symlinks are refused'

# The review collision: the parent isolation name is also the nested checkout's
# path component. Start the parent first, since native startup rotates its state.
rm -rf -- "$descendant_state"
descendant_state=""
DEVENV_ROOT="$nested_child" WORKTREE_TEARDOWN_EDITOR_RELEASE=0 \
  bash "$ROOT/nix/devenv-modules/tasks/shared/worktree-teardown.sh"
collision_started=true
(cd "$nested_outer" && "$BUCK2" --isolation-dir nested targets //: >/dev/null)
(cd "$nested_child" && "$BUCK2" --isolation-dir child targets //: >/dev/null)
collision_parent_pid="$(cat "$child_state/buckd.pid")"
child_pid="$(cat "$child_state/child/buckd.pid")"
chmod 555 "$nested_child" "$nested_child/readonly"
for iteration in first second; do
  if (cd "$nested_outer" && "$DEVENV" tasks run worktree:teardown --mode single) \
    >"$TEMP_ROOT/collision-refusal.log" 2>&1; then
    fail 'teardown accepted an isolation containing descendant checkout state'
  fi
  "$BUN" -e 'if (!require("node:fs").readFileSync(process.argv[1], "utf8").includes("refusing ambiguous Buck isolation content")) process.exit(1)' \
    "$TEMP_ROOT/collision-refusal.log" || fail 'collision refusal lacks a clear diagnostic'
  [ "$(cat "$child_state/buckd.pid")" = "$collision_parent_pid" ] || fail 'ambiguous parent metadata changed'
  [ "$(cat "$child_state/child/buckd.pid")" = "$child_pid" ] || fail 'colliding nested metadata changed'
  kill -0 "$collision_parent_pid" && kill -0 "$child_pid" || fail 'collision refusal stopped a daemon'
  "$BUN" -e 'const fs=require("node:fs"); for (const path of process.argv.slice(1)) if ((fs.statSync(path).mode & 0o777) !== 0o555) process.exit(1)' \
    "${protected[@]}" || fail 'collision refusal changed protected directory modes'
done
(cd "$nested_outer" && "$BUCK2" --isolation-dir nested status >/dev/null)
(cd "$nested_child" && "$BUCK2" --isolation-dir child status >/dev/null)
echo 'PASS: colliding parent isolation/nested-checkout state is refused twice with a clear diagnostic; both live daemons and their metadata remain intact'
