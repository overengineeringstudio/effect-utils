#!/usr/bin/env bash

compute_hash() {
  sha256sum | awk '{print $1}'
}

emit_dir_state() {
  local dir="$1"

  if [ ! -d "$dir" ]; then
    return
  fi

  find "$dir" \
    \( \
      -name .git -o \
      -name .direnv -o \
      -name .devenv -o \
      -name .turbo -o \
      -name .cache -o \
      -name node_modules -o \
      -name dist -o \
      -name coverage -o \
      -name result -o \
      -name tmp \
    \) -prune -o -type f -print \
    | LC_ALL=C sort \
    | while IFS= read -r file; do
      printf '%s ' "${file#"$dir"/}"
      sha256sum "$file" | awk '{print $1}'
    done
}

resolve_gvs_links_dir() {
  if [ -n "${PNPM_HOME:-}" ]; then
    printf '%s\n' "${PNPM_HOME}/store/v11/links"
  elif [ -n "${XDG_DATA_HOME:-}" ] && [ -d "${XDG_DATA_HOME}/pnpm/store/v11" ]; then
    printf '%s\n' "${XDG_DATA_HOME}/pnpm/store/v11/links"
  elif [ -d "$HOME/.local/share/pnpm/store/v11" ]; then
    printf '%s\n' "$HOME/.local/share/pnpm/store/v11/links"
  elif [ -d "$HOME/Library/pnpm/store/v11" ]; then
    printf '%s\n' "$HOME/Library/pnpm/store/v11/links"
  fi
}

cache_fingerprint() {
  local workspace_state_hash="$1"
  local gvs_links_dir="$2"

  {
    printf '%s\n' "$workspace_state_hash"
    printf '%s\n' "$gvs_links_dir"
  } | compute_hash
}

check_node_modules_links_healthy() {
  local node_bin="$1"
  local projection_script="$2"
  shift 2

  for node_modules_dir in "$@"; do
    if [ ! -d "$node_modules_dir" ]; then
      continue
    fi

    broken_link="$(
      find "$node_modules_dir" -mindepth 1 -maxdepth 2 -type l ! -exec test -e {} \; -print -quit
    )"
    if [ -n "$broken_link" ]; then
      echo "[pnpm] Broken node_modules symlink detected: $broken_link" >&2
      return 1
    fi
  done

  # Feed the projection checker the exact node_modules directories we validated
  # for broken symlinks so the fast path and the authoritative task share the
  # same notion of a healthy pnpm projection.
  NODE_MODULES_DIRS="$(printf '%s\n' "$@")" "$node_bin" "$projection_script"
}

purge_node_modules() {
  for node_modules_dir in "$@"; do
    rm -rf "$node_modules_dir"
  done
}
