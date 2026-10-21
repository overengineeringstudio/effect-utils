#!/usr/bin/env bash

# No remote mutation: classify a fetched tip against the eligible target.
decide() {
  local tip="$1" target="$2" result
  if [ -z "$tip" ]; then
    echo create
    return
  fi
  if [ "$tip" = "$target" ]; then
    echo noop
    return
  fi
  if git merge-base --is-ancestor "$target" "$tip"; then
    echo noop
    return
  else
    result=$?
    if [ "$result" -ne 1 ]; then return "$result"; fi
  fi
  if git merge-base --is-ancestor "$tip" "$target"; then
    echo push
  else
    result=$?
    if [ "$result" -ne 1 ]; then return "$result"; fi
    echo diverged
  fi
}
