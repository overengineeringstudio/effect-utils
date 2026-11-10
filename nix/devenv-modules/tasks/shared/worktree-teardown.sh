#!/usr/bin/env bash
set -euo pipefail
shopt -s dotglob nullglob

# A failed teardown is not permission to mutate shared snapshot payload inodes.
trap 'status=$?; if [ "$status" -ne 0 ]; then
  printf "%s\n" \
    "worktree:teardown: failed; fix the reported error and rerun worktree:teardown." \
    "Never fall back to chmod -R or rm -rf on a worktree: recursive permission changes corrupt the hardlinked shared content store." \
    "If shared blobs were made writable, stop all editor-view readers/writers, then run:" \
    "bun packages/@overeng/buck2-tools/src/editor-view.ts repair-content --repo-root <repo> --quiesced true" >&2
fi' EXIT

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
  # Parse exact roots, failing closed on unfamiliar JSON rather than masking watch-del errors.
  if watch_list="$(watchman "${watchman_args[@]}" watch-list 2>/dev/null)" &&
    WATCHMAN_TEARDOWN_ROOT="$root" awk '
      function trim() { sub(/^[[:space:]]+/, "", json) }
      function string(    token, value, i, c) {
        trim()
        if (!match(json, /^"([^"\\[:cntrl:]]|\\["\\/bfnrt])*"/)) { invalid = 1; return "" }
        token = substr(json, 2, RLENGTH - 2)
        json = substr(json, RLENGTH + 1)
        value = ""
        for (i = 1; i <= length(token); i++) {
          c = substr(token, i, 1)
          if (c == "\\") {
            c = substr(token, ++i, 1)
            if (c in escapes) c = escapes[c]
          }
          value = value c
        }
        return value
      }
      BEGIN {
        escapes["b"] = "\b"; escapes["f"] = "\f"; escapes["n"] = "\n"
        escapes["r"] = "\r"; escapes["t"] = "\t"
      }
      { json = json $0 "\n" }
      END {
        trim()
        if (!sub(/^\{[[:space:]]*"version"[[:space:]]*:[[:space:]]*/, "", json)) exit 1
        string()
        trim()
        if (invalid || !sub(/^,[[:space:]]*"roots"[[:space:]]*:[[:space:]]*\[/, "", json)) exit 1
        trim()
        if (substr(json, 1, 1) != "]") {
          while (1) {
            value = string()
            if (invalid) exit 1
            if (value == ENVIRON["WATCHMAN_TEARDOWN_ROOT"]) found = 1
            trim()
            if (substr(json, 1, 1) != ",") break
            json = substr(json, 2)
          }
        }
        if (json !~ /^\][[:space:]]*\}[[:space:]]*$/) exit 1
        exit !found
      }
    ' <<<"$watch_list"; then
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
  WORKTREE_TEARDOWN_EDITOR_RETIRE=1 DEVENV_TUI=false devenv tasks run buck2:editor:release --mode single
fi

# Find ownership markers separately from directories: no shell/stat tests per
# directory. Encode boundaries as "path/" and directories as "path//"; sorting
# puts each boundary before its root and descendants, even for newline names.
# The streaming filter prunes whole ownership prefixes before batched chmod.
{
  # Use fixed relative names to exempt the worktree's own markers, without
  # interpreting glob characters that may occur in its canonical root path.
  # Unreadable directories cannot expose markers or descendants: prune them in
  # both scans, but still emit owned unreadable roots for chmod below.
  find -P . \
    \( ! -path './.git' ! -path './.bare' \
      ! -path './megarepo.kdl' ! -path './megarepo.json' \
      \( -name .git -o \( -name .bare -xtype d \) -o \
        \( \( -name megarepo.kdl -o -name megarepo.json \) -xtype f \) \) \
      -printf '%h/\0' \) , \( -type d ! -readable -prune \)
  if [ -f "$root/megarepo.kdl" ] || [ -f "$root/megarepo.json" ]; then
    printf './repos/\0'
  fi
  find -P . -type d ! -readable -printf '%p//\0' -prune -o \
    -type d -printf '%p//\0'
} | LC_ALL=C sort -zu | awk '
  BEGIN { RS = "\0"; ORS = "\0" }
  {
    if (protected != "" && index($0, protected) == 1) next
    protected = ""
    if (substr($0, length($0) - 1) == "//") {
      print substr($0, 1, length($0) - 2)
    } else {
      protected = $0
    }
  }
' | xargs -0 -r chmod u+w --
