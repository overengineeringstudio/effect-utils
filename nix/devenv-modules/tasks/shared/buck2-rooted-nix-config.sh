#!/usr/bin/env bash

# Source this file, then call buck2_root_nix_config VARIABLE FLAKE_REF.
# The resulting config and its closure remain GC-rooted until the caller exits.
buck2_rooted_nix_config_dir=""

buck2_rooted_nix_config_cleanup() {
  if [ -n "$buck2_rooted_nix_config_dir" ]; then
    "${BUCK2_ROOTED_RM_BIN:-rm}" -f "$buck2_rooted_nix_config_dir/config"
    "${BUCK2_ROOTED_RMDIR_BIN:-rmdir}" "$buck2_rooted_nix_config_dir" 2>/dev/null || true
    buck2_rooted_nix_config_dir=""
  fi
}

buck2_rooted_nix_config_signal() {
  local signal="$1"
  buck2_rooted_nix_config_cleanup
  case "$signal" in
    INT) exit 130 ;;
    TERM) exit 143 ;;
    *) exit 128 ;;
  esac
}

buck2_root_nix_config() {
  local output_variable="$1"
  local flake_ref="$2"
  local root target

  [ -z "$buck2_rooted_nix_config_dir" ] || {
    echo "buck2-rooted-nix-config: one rooted config per task invocation" >&2
    return 64
  }
  root="$(${BUCK2_ROOTED_MKTEMP_BIN:-mktemp} -d "${TMPDIR:-/tmp}/buck2-toolchain-root.XXXXXX")"
  buck2_rooted_nix_config_dir="$root"
  trap buck2_rooted_nix_config_cleanup EXIT
  trap 'buck2_rooted_nix_config_signal INT' INT
  trap 'buck2_rooted_nix_config_signal TERM' TERM

  target="$(${BUCK2_ROOTED_NIX_BIN:-nix} build \
    --out-link "$root/config" \
    --print-out-paths \
    "$flake_ref")" || return
  case "$target" in
    *$'\n'*) echo "buck2-rooted-nix-config: build returned multiple store paths" >&2; return 1 ;;
    /nix/store/*) ;;
    *) echo "buck2-rooted-nix-config: build returned a non-store path" >&2; return 1 ;;
  esac
  [ -L "$root/config" ] || {
    echo "buck2-rooted-nix-config: Nix did not create the requested GC root" >&2
    return 1
  }
  [ "$(${BUCK2_ROOTED_READLINK_BIN:-readlink} -f "$root/config")" = "$target" ] || {
    echo "buck2-rooted-nix-config: GC root does not bind the reported config" >&2
    return 1
  }
  [ -f "$target" ] || {
    echo "buck2-rooted-nix-config: rooted config is not a regular file" >&2
    return 1
  }

  printf -v "$output_variable" '%s' "$target"
  export BUCK2_ROOTED_NIX_CONFIG_ROOT="$root/config"
}
