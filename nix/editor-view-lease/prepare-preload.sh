#!/usr/bin/env bash
# Keep Bun's resolver away from large store ancestors (oven-sh/bun#32389).
set -euo pipefail
umask 077
source_file="$1"
fail() {
  printf 'editor-view-source: untrusted preload %s: %s; remove %s; the next launch reinstalls it\n' "$1" "$preload" "$preload" >&2
  exit 1
}
uid="$(id -u)"
reject_directory() {
  printf 'editor-view-source: unsafe runtime directory %s; fix its ownership/permissions and those of its ancestors, or select another runtime directory\n' "$1" >&2
  return 1
}
check_private_directory() {
  local path="$1" owner mode
  [[ -d "$path" && ! -L "$path" ]] || reject_directory "$path" || return 1
  owner="$(stat -c %u -- "$path")" || return 1
  mode="$(stat -c %a -- "$path")" || return 1
  [[ "$owner" == "$uid" ]] && (( (8#$mode & 0022) == 0 )) || reject_directory "$path"
}
select_directory() {
  local candidate="$1" resolved component owner mode
  resolved="$(realpath -e -- "$candidate" 2>/dev/null)" || { reject_directory "$candidate"; return 1; }
  # Node and Bun tokenize runtime options differently. Never export a path
  # requiring either runtime's quoting or escaping rules.
  [[ "$resolved/editor-view-lease" =~ ^[A-Za-z0-9._/+-]+$ ]] || { reject_directory "$resolved"; return 1; }
  check_private_directory "$resolved" || return 1
  component="$resolved"
  while :; do
    [[ -d "$component" && ! -L "$component" ]] || { reject_directory "$component"; return 1; }
    owner="$(stat -c %u -- "$component")" || return 1
    mode="$(stat -c %a -- "$component")" || return 1
    if [[ "$owner" != 0 && "$owner" != "$uid" ]] ||
      (( (8#$mode & 0022) != 0 && (8#$mode & 01000) == 0 )); then
      reject_directory "$component"
      return 1
    fi
    [[ "$component" != / ]] || break
    component="$(dirname -- "$component")"
  done
  directory="$resolved/editor-view-lease"
  if ! mkdir -m 0700 -- "$directory" 2>/dev/null; then
    check_private_directory "$directory" || return 1
  fi
  check_private_directory "$directory" || return 1
}
candidates=()
if [[ "$(uname -s)" == Linux && -n "${XDG_RUNTIME_DIR:-}" ]]; then
  candidates+=("$XDG_RUNTIME_DIR")
fi
if [[ "$(uname -s)" == Darwin && -n "${TMPDIR:-}" ]]; then
  candidates+=("$TMPDIR")
fi
fallback="${HOME:?}/.cache"
for candidate in "${candidates[@]}" "$fallback"; do
  if [[ "$candidate" == "$fallback" ]] && ! mkdir -p -m 0700 -- "$candidate" 2>/dev/null; then
    reject_directory "$candidate" || :
    continue
  fi
  if select_directory "$candidate"; then
    break
  fi
  directory=""
done
if [[ -z "${directory:-}" ]]; then
  printf 'editor-view-source: no trusted runtime directory; fix the reported paths or configure a private runtime directory with safe ancestors and no whitespace/unsafe characters\n' >&2
  exit 1
fi
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
