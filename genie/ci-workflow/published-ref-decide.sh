#!/usr/bin/env bash

# No remote mutation: classify a fetched tip against the eligible target.
decide() {
  local tip="$1" target="$2" result
  if [ -z "$tip" ]; then
    echo create
    return
  fi
  # Publisher tips carry main as their second parent; legacy tips are main commits.
  local main="$tip" parents trailer
  parents="$(git show -s --format=%P "$tip")"
  trailer="$(git show -s --format='%(trailers:key=Published-From,valueonly)' "$tip")"
  if [ -n "$trailer" ]; then
    if [ "$(wc -w <<< "$parents")" -ne 2 ]; then return 1; fi
    main="$(git rev-parse "$tip^2")"
    if [ "$trailer" != "$main" ]; then return 1; fi
  fi
  if [ "$main" = "$target" ]; then
    echo noop
    return
  fi
  if git merge-base --is-ancestor "$target" "$main"; then
    echo noop
    return
  else
    result=$?
    if [ "$result" -ne 1 ]; then return "$result"; fi
  fi
  if git merge-base --is-ancestor "$main" "$target"; then
    echo push
  else
    result=$?
    if [ "$result" -ne 1 ]; then return "$result"; fi
    echo noop
  fi
}
