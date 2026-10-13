#!/usr/bin/env bash
set -euo pipefail
shopt -s dotglob nullglob

# Resolve the checkout itself, not the caller's subdirectory or a logical symlink.
root="$(git -C "${DEVENV_ROOT:-$PWD}" rev-parse --show-toplevel)"
root="$(realpath "$root")"
cd "$root"

home="$(realpath -m -- "$HOME")"
for component_path in "$home/.buck" "$home/.buck/buckd"; do
  if [ -L "$component_path" ]; then
    echo "worktree:teardown: refusing symlinked Buck state component: $component_path" >&2
    exit 1
  fi
done
base="$(realpath -m -- "$home/.buck/buckd")"
state="$(realpath -m -- "$base/${root#/}")"
case "$state" in
  "$base"|"$base"/*) ;;
  *) echo "worktree:teardown: Buck state escapes canonical base: $state" >&2; exit 1 ;;
esac
# Checking only the last component would allow an ancestor symlink to redirect
# the entire root-keyed state tree, even to another location inside the base.
component_path="$base"
remaining="${root#/}"
while [ -n "$remaining" ]; do
  component="${remaining%%/*}"
  component_path="$component_path/$component"
  if [ -L "$component_path" ]; then
    echo "worktree:teardown: refusing symlinked Buck state component: $component_path" >&2
    exit 1
  fi
  if [ "$remaining" = "$component" ]; then break; fi
  remaining="${remaining#*/}"
done

# The pinned Buck lifecycle client owns only the `prev` history directory
# (buck2_client_ctx/src/daemon/client.rs, BuckdLifecycleLock::BUCKD_PREV_DIR).
# Even an isolation can share its path with a descendant checkout's state.
verify_isolation_contents() {
  local directory="$1" entry history
  for entry in "$directory"/*; do
    if [ -L "$entry" ]; then
      echo "worktree:teardown: refusing ambiguous Buck isolation content (symlink): $entry" >&2
      return 1
    elif [ -f "$entry" ]; then
      continue
    elif [ -d "$entry" ]; then
      if [ -e "$root/${directory##*/}/${entry##*/}" ] || [ -L "$root/${directory##*/}/${entry##*/}" ]; then
        echo "worktree:teardown: refusing ambiguous Buck isolation content (descendant path exists): $entry" >&2
        return 1
      fi
      if [ "${entry##*/}" != prev ]; then
        echo "worktree:teardown: refusing ambiguous Buck isolation content (unknown directory): $entry" >&2
        return 1
      fi
      # Buck history consists of regular daemon files. A directory inside it
      # may be descendant state moved by an earlier native daemon restart.
      for history in "$entry"/*; do
        if [ -L "$history" ] || [ ! -f "$history" ]; then
          echo "worktree:teardown: refusing ambiguous Buck isolation content (history): $history" >&2
          return 1
        fi
      done
    else
      echo "worktree:teardown: refusing ambiguous Buck isolation content: $entry" >&2
      return 1
    fi
  done
}

if [ -d "$state" ]; then
  for directory in "$state"/*; do
    [ -e "$directory" ] || [ -L "$directory" ] || continue
    if [ ! -d "$directory" ] || [ -L "$directory" ]; then
      echo "worktree:teardown: invalid Buck isolation state: $directory" >&2
      exit 1
    fi
    # Absolute roots share prefix directories: a child checkout's state is NOT
    # an isolation of this checkout. Only direct daemon files identify one.
    isolation=false
    for marker in buckd.info buckd.pid buckd.stdout buckd.stderr buckd.lifecycle; do
      if [ -L "$directory/$marker" ]; then
        echo "worktree:teardown: refusing symlinked Buck daemon file: $directory/$marker" >&2
        exit 1
      fi
      if [ -f "$directory/$marker" ]; then isolation=true; fi
    done
    [ "$isolation" = true ] || continue
    # Refuse ambiguity before even stopping this daemon or deleting its files.
    verify_isolation_contents "$directory"
    # Native kill is offline and never starts a daemon. Use its protocol rather
    # than signaling a potentially recycled PID from buckd.pid.
    buck2 --isolation-dir "${directory##*/}" kill
    verify_isolation_contents "$directory"
    # Never recursively delete an isolation or its history. Shallow regular-file
    # deletion plus rmdir leaves any newly appearing unknown directory intact.
    find -P "$directory" -mindepth 1 -maxdepth 1 -type f -delete
    if [ -d "$directory/prev" ] && [ ! -L "$directory/prev" ]; then
      find -P "$directory/prev" -mindepth 1 -maxdepth 1 -type f -delete
      rmdir -- "$directory/prev"
    fi
    rmdir -- "$directory"
  done
  remaining_directories=( "$state"/* )
  if [ "${#remaining_directories[@]}" = 0 ]; then rmdir -- "$state"; fi
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

# Read-only Buck materializations may remain. Nested Git and megarepo ownership
# boundaries are pruned before chmod, including their root directories.
find -P "$root" -type d \
  \( -exec bash -c '
    directory=$1
    [ "$directory" != "$2" ] &&
    { [ -e "$directory/.git" ] || [ -L "$directory/.git" ] ||
      [ -f "$directory/megarepo.kdl" ] || [ -f "$directory/megarepo.json" ] ||
      [ -d "$directory/.bare" ] ||
      { [ "${directory##*/}" = repos ] &&
        { [ -f "${directory%/*}/megarepo.kdl" ] || [ -f "${directory%/*}/megarepo.json" ]; }; }; }
  ' bash {} "$root" \; \) -prune -o -type d -exec chmod u+w -- {} +
