#!/usr/bin/env bash
set -euo pipefail

workspace_root="${1:?workspace root is required}"
task_name="${2:?task name is required}"
cache_root="${3:?cache root is required}"

case "$workspace_root:$cache_root" in
  /*:/*) ;;
  *)
    echo "cargo target workspace and cache roots must be absolute" >&2
    exit 1
    ;;
esac

workspace_key="$(printf '%s' "$workspace_root" | sha256sum | cut -c1-16)"
task_key="$(printf '%s' "$task_name" | tr -c 'A-Za-z0-9._-' '-')"
target_dir="$cache_root/effect-utils/cargo-target/$workspace_key/$task_key"

case "$target_dir/" in
  "$workspace_root"/*)
    echo "cargo target directory must remain outside the workspace" >&2
    exit 1
    ;;
esac

printf '%s\n' "$target_dir"
