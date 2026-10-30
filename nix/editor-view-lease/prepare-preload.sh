#!/usr/bin/env bash
# Keep Bun's resolver away from large store ancestors (oven-sh/bun#32389).
set -euo pipefail
umask 077
source_file="$1"
fail() { printf 'editor-view-source: untrusted preload %s\n' "$1" >&2; exit 1; }
uid="$(id -u)"
if [[ "$(uname -s)" == Linux && -n "${XDG_RUNTIME_DIR:-}" ]]; then
  base="$XDG_RUNTIME_DIR"
elif [[ "$(uname -s)" == Darwin && -n "${TMPDIR:-}" ]]; then
  base="$TMPDIR"
else
  base="${HOME:?}/.cache"
  mkdir -p -- "$base"
fi
# A private leaf cannot be trusted if another user can replace it in its parent.
check_directory() {
  local path="$1" owner mode
  [[ -d "$path" && ! -L "$path" ]] || fail directory
  owner="$(stat -c %u -- "$path")"
  mode="$(stat -c %a -- "$path")"
  [[ "$owner" == "$uid" ]] && (( (8#$mode & 0022) == 0 )) || fail directory
}
check_directory "${base%/}"
directory="${base%/}/editor-view-lease"
if ! mkdir -m 0700 -- "$directory" 2>/dev/null; then
  check_directory "$directory"
fi
check_directory "$directory"
digest="$(sha256sum -- "$source_file")"
digest="${digest%% *}"
preload="$directory/preload-$digest.cjs"
verify() {
  local actual
  [[ -f "$preload" && ! -L "$preload" ]] || fail file
  [[ "$(stat -c %u -- "$preload")" == "$uid" ]] || fail owner
  [[ "$(stat -c %a -- "$preload")" == 444 ]] || fail mode
  actual="$(sha256sum -- "$preload")"
  [[ "${actual%% *}" == "$digest" ]] || fail hash
}
if [[ ! -e "$preload" && ! -L "$preload" ]]; then
  temporary="$(mktemp "$directory/.preload.XXXXXXXXXX")"
  trap 'rm -f -- "$temporary"' EXIT
  cat -- "$source_file" > "$temporary"
  sync -- "$temporary"
  chmod 0444 -- "$temporary"
  # GNU mv uses no-replace rename where available. All competing installers
  # publish identical bytes; an existing destination is verified, never repaired.
  mv --no-clobber --no-target-directory -- "$temporary" "$preload"
fi
verify
printf '%s\n' "$preload"
