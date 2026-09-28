#!/usr/bin/env bash
# Enumerate the deploy targets inside a staged Netlify artifact.
#
# Usage: netlify-staged-targets.sh <stage-dir> [max-targets]
#
# The stage directory comes from an untrusted build, so its layout is data:
# every top-level entry must be a real directory (not a symlink) whose name is
# a Netlify-alias-safe slug. Prints the valid target names, one per line, and
# fails without printing anything when any entry is rejected, the stage is
# empty, or it holds more than `max-targets` (default 32) entries.

readonly netlify_staged_target_name_pattern='^[a-z0-9][a-z0-9-]{0,62}$'

netlify_staged_target_name_is_valid() {
  [[ "$1" =~ $netlify_staged_target_name_pattern ]]
}

netlify_staged_targets_main() {
  set -euo pipefail
  shopt -s nullglob dotglob

  if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "Usage: netlify-staged-targets.sh <stage-dir> [max-targets]" >&2
    return 2
  fi
  local stage_dir="$1"
  local max_targets="${2:-32}"
  if ! [[ "$max_targets" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: max-targets must be a positive integer, got $(printf '%q' "$max_targets")" >&2
    return 2
  fi
  if [ -L "$stage_dir" ] || [ ! -d "$stage_dir" ]; then
    echo "Error: stage directory $(printf '%q' "$stage_dir") is not a directory" >&2
    return 1
  fi

  local entry name
  local -a targets=()
  local -a rejected=()
  for entry in "$stage_dir"/*; do
    name="${entry##*/}"
    if ! netlify_staged_target_name_is_valid "$name"; then
      rejected+=("$(printf '%q' "$name") (name must match $netlify_staged_target_name_pattern)")
    elif [ -L "$entry" ]; then
      rejected+=("$name (symlink)")
    elif [ ! -d "$entry" ]; then
      rejected+=("$name (not a directory)")
    else
      targets+=("$name")
    fi
  done

  if [ "${#rejected[@]}" -gt 0 ]; then
    echo "Error: staged Netlify output has invalid top-level entries:" >&2
    printf '  %s\n' "${rejected[@]}" >&2
    return 1
  fi
  if [ "${#targets[@]}" -eq 0 ]; then
    echo "Error: staged Netlify output in $(printf '%q' "$stage_dir") has no targets" >&2
    return 1
  fi
  if [ "${#targets[@]}" -gt "$max_targets" ]; then
    echo "Error: staged Netlify output has ${#targets[@]} targets; at most $max_targets are deployed" >&2
    return 1
  fi
  printf '%s\n' "${targets[@]}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  netlify_staged_targets_main "$@"
fi
