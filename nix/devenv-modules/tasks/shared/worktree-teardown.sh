#!/usr/bin/env bash
set -euo pipefail
shopt -s dotglob nullglob

# Resolve the checkout itself, not the caller's subdirectory or a logical symlink.
root="$(git -C "${DEVENV_ROOT:-$PWD}" rev-parse --show-toplevel)"
root="$(realpath "$root")"
cd "$root"

state="$HOME/.buck/buckd/${root#/}"
if [ -L "$state" ]; then
  echo "worktree:teardown: refusing symlinked Buck state: $state" >&2
  exit 1
fi
if [ -d "$state" ]; then
  for directory in "$state"/*; do
    [ -e "$directory" ] || [ -L "$directory" ] || continue
    if [ ! -d "$directory" ] || [ -L "$directory" ]; then
      echo "worktree:teardown: invalid Buck isolation state: $directory" >&2
      exit 1
    fi
    # Native kill is offline and never starts a daemon. Use its protocol rather
    # than signaling a potentially recycled PID from buckd.pid.
    buck2 --isolation-dir "${directory##*/}" kill
  done
  rm -rf -- "$state"
fi

# Never spawn a Watchman service just to release a watch. A missing/unreachable
# service has no watch we can release; leave other roots and services alone.
if command -v watchman >/dev/null 2>&1; then
  watchman_args=(--no-spawn --no-local --output-encoding=json)
  if [ -n "${WATCHMAN_SOCK:-}" ]; then watchman_args+=("--sockname=$WATCHMAN_SOCK"); fi
  if watchman "${watchman_args[@]}" watch-list >/dev/null 2>&1; then
    watchman "${watchman_args[@]}" watch-del "$root"
  fi
fi

# Only watcher admission is root-keyed. REAPI/archive endpoint entries are shared
# between roots and are not ours to delete. The prefix also covers temp writes.
root_hash="$(printf %s "$root" | sha256sum)"
root_hash="${root_hash%% *}"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/effect-utils/buck2-posture-v2"
for entry in "$cache/$root_hash-"*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  rm -f -- "$entry"
done

# The module sets this only when the consumer defines the existing release task.
if [ "${WORKTREE_TEARDOWN_EDITOR_RELEASE:-0}" = 1 ]; then
  DEVENV_TUI=false devenv tasks run buck2:editor:release --mode single
fi

# Read-only Buck materializations may remain. Do not chmod files or traverse
# symlinks into the Nix store, sibling checkouts, or external editor inputs.
find -P "$root" -type d -exec chmod u+w -- {} +
