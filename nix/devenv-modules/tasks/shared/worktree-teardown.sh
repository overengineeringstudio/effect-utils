#!/usr/bin/env bash
# Usage: worktree-teardown <worktree-path> (absolute or relative).
# Requires Bash, Git, GNU coreutils/findutils and awk with NUL record support.
# buck2 is required when root-owned daemon state exists; Watchman is optional
# and never spawned, with jq required only when its service is reachable.
# HOME locates Buck state; XDG_CACHE_HOME overrides the admission cache location;
# WATCHMAN_SOCK selects a service. WORKTREE_TEARDOWN_EDITOR_RELEASE=1 explicitly
# permits the checkout's devenv editor-release task; otherwise no checkout code
# is executed. Even opted-in release disables Nix builds and substitutions.
# Exit 0: completed; 2: usage error; 3: editor view present without release opt-in.
# Other nonzero statuses: failure (including command failures); do not remove.
set -euo pipefail
shopt -s dotglob nullglob

# A failed teardown is not permission to mutate shared snapshot payload inodes.
report_failure() {
  local status=$?
  if [ "$status" -eq 0 ] || [ "$status" -eq 3 ]; then return; fi
  printf 'worktree-teardown: failed; fix the reported error and rerun: worktree-teardown %q\n' \
    "${root:-<worktree-path>}" >&2
  printf "%s\n" \
    "Never fall back to chmod -R or rm -rf on a worktree: recursive permission changes corrupt the hardlinked shared content store." \
    "If shared blobs were made writable, stop all editor-view readers/writers, then use a trusted effect-utils checkout's absolute script path:" \
    "bun /absolute/path/to/effect-utils/packages/@overeng/buck2-tools/src/editor-view.ts repair-content --repo-root <repo> --quiesced true" >&2
}
trap report_failure EXIT

# Resolve only the explicit target, never the caller's cwd or shell environment.
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: worktree-teardown <worktree-path>" >&2
  exit 2
fi
root="$(git -C "$1" rev-parse --show-toplevel)"
root="$(realpath "$root")"
cd "$root"

# Refuse before stopping services, deleting state, or changing any permissions.
# Include lease-only roots and dangling symlinks; nested owners are not ours.
if [ "${WORKTREE_TEARDOWN_EDITOR_RELEASE:-0}" != 1 ]; then
  find -P . -name .git -prune -o -name .bare -prune -o \
    -name .editor-view -print0 -prune |
    while IFS= read -r -d '' editor_root; do
      owner="${editor_root%/*}"
      while [ "$owner" != . ]; do
        if [ -e "$owner/.git" ] || [ -L "$owner/.git" ] || \
          [ -e "$owner/.bare" ] || [ -L "$owner/.bare" ] || \
          [ -f "$owner/megarepo.kdl" ] || [ -f "$owner/megarepo.json" ]; then
          continue 2
        fi
        if [ "$owner" = ./repos ] && { [ -f megarepo.kdl ] || [ -f megarepo.json ]; }; then
          continue 2
        fi
        owner="${owner%/*}"
      done
      printf 'worktree-teardown: editor view present: %s; rerun with WORKTREE_TEARDOWN_EDITOR_RELEASE=1 worktree-teardown %q\n' \
        "$root/${editor_root#./}" "$root" >&2
      exit 3
    done
fi

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
  if watch_list="$(watchman "${watchman_args[@]}" watch-list 2>/dev/null)"; then
    if ! command -v jq >/dev/null 2>&1; then
      echo "worktree:teardown: jq is required to check watched roots" >&2
      exit 1
    fi
    # Check exact root membership rather than suppressing genuine watch-del errors.
    # shellcheck disable=SC2016
    if jq -e --arg root "$root" 'any(.roots[]?; . == $root)' >/dev/null <<<"$watch_list"; then
      watchman "${watchman_args[@]}" watch-del "$root"
    fi
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

# There is no reliable cached-shell identity available without evaluation.
# Opt-in is explicit because this task executes code from the retiring checkout.
if [ "${WORKTREE_TEARDOWN_EDITOR_RELEASE:-0}" = 1 ]; then
  NIX_CONFIG="${NIX_CONFIG:-}
max-jobs = 0
builders =
substitute = false" \
    WORKTREE_TEARDOWN_EDITOR_RETIRE=1 DEVENV_TUI=false DEVENV_ROOT="$root" \
    devenv tasks run buck2:editor:release --mode single
else
  echo "worktree:teardown: editor release skipped (set WORKTREE_TEARDOWN_EDITOR_RELEASE=1 to opt in; Nix builds remain disabled)"
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
