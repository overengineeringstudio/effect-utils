#!/usr/bin/env bash

# No remote mutation: classify a fetched tip against the eligible target.
decide() {
  local tip="$1" target="$2" lineage="$3" result
  if [ -z "$tip" ]; then
    echo create
    return
  fi
  # Main-lineage commits are legacy tips regardless of their message or parents.
  local main="$tip" parents trailer
  if git merge-base --is-ancestor "$tip" "$lineage"; then
    :
  else
    result=$?
    if [ "$result" -ne 1 ]; then return "$result"; fi
    parents="$(git show -s --format=%P "$tip")"
    trailer="$(git show -s --format='%(trailers:key=Published-From,valueonly)' "$tip")"
    if [ "$(wc -w <<< "$parents")" -ne 2 ]; then echo diverged; return; fi
    main="$(git rev-parse "$tip^2")"
    if [ "$trailer" != "$main" ] || ! git merge-base --is-ancestor "$main" "$lineage"; then
      echo diverged
      return
    fi
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

# Bound both producer paths below the job-output limit and Linux's per-env-string limit.
manifest_outputs() {
  local manifest index
  manifest="$(base64 -w0 "$1")" || return
  if [ "${#manifest}" -gt 400000 ]; then
    echo "::error::Manifest exceeds the 400000-character promotion output limit" >&2
    return 1
  fi
  for index in 0 1 2 3; do
    printf 'manifest-base64-%s=%s\n' "$index" "${manifest:index*100000:100000}"
  done
}

decode_manifest() {
  local manifest="${MANIFEST_BASE64_0}${MANIFEST_BASE64_1}${MANIFEST_BASE64_2}${MANIFEST_BASE64_3}"
  if [ -z "$manifest" ] || [ "${#manifest}" -gt 400000 ] || ! [[ "$manifest" =~ ^[A-Za-z0-9+/]*={0,2}$ ]]; then
    echo "::error::Invalid base64 promotion manifest" >&2
    return 1
  fi
  printf %s "$manifest" | base64 --decode
}
