#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 [--cold-build] <flake-ref>" >&2
  exit 2
}

cold_build=false
if [ "${1:-}" = "--cold-build" ]; then
  cold_build=true
  shift
fi
[ "$#" -eq 1 ] || usage
target_ref="$1"

evict_out_path() {
  local drv="$1"
  local out_path="$2"
  local warning rebuild_log

  if nix path-info "$out_path" >/dev/null 2>&1; then
    echo "evicting cached: $(basename "$out_path")"
    if nix store delete --ignore-liveness "$out_path" >/dev/null 2>&1; then
      echo "freshness_mode=strict-delete drv=$drv out=$out_path"
      if nix path-info "$out_path" >/dev/null 2>&1; then
        echo "::error::cached pnpm-deps output still present after successful eviction: $out_path"
        exit 1
      fi
      echo "delete_verified=true drv=$drv out=$out_path"
    else
      echo "freshness_mode=rebuild-check reason=immutable-global-store drv=$drv out=$out_path"
      warning="cached pnpm-deps output is immutable; forcing a Nix rebuild check for $drv"
      echo "::warning title=pnpm deps freshness fallback::$warning"
      if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
        printf '%s\n' "### pnpm deps freshness fallback" "" "- mode: \`rebuild-check\`" "- output: \`$out_path\`" "- derivation: \`$drv\`" >>"$GITHUB_STEP_SUMMARY"
      fi
      rebuild_log=$(mktemp)
      if ! nix build --no-link --rebuild -L "$drv^*" 2>&1 | tee "$rebuild_log"; then
        rm -f "$rebuild_log"
        echo "::error::rebuild check failed for cached pnpm-deps output: $out_path"
        exit 1
      fi
      if ! grep -F "checking outputs of '$drv'" "$rebuild_log" >/dev/null; then
        rm -f "$rebuild_log"
        echo "::error::rebuild check did not prove builder execution for: $drv"
        exit 1
      fi
      rm -f "$rebuild_log"
      echo "rebuild_check_verified=true drv=$drv out=$out_path"
    fi
  else
    echo "freshness_mode=not-present drv=$drv out=$out_path"
  fi
}

process_drv() {
  local attr_name="$1"
  local drv="$2"
  local installable="${drv}^*"
  local outputs

  if "$cold_build"; then
    echo "cold-building pnpm deps: ${attr_name:-$drv}"
    nix build --no-link "$installable" --option substituters "https://cache.nixos.org" || true
    outputs=$(nix path-info "$installable" 2>/dev/null || true)
  else
    outputs=$(nix-store -q --outputs "$drv" 2>/dev/null || true)
  fi

  while IFS= read -r out_path; do
    [ -n "$out_path" ] || continue
    evict_out_path "$drv" "$out_path"
  done <<<"$outputs"

  if "$cold_build"; then
    nix build --no-link "$installable" --option substituters "https://cache.nixos.org"
  fi
}

entries_json=$(mktemp)
trap 'rm -f "$entries_json"' EXIT
if nix eval --json "$target_ref.passthru.depsBuildEntries" >"$entries_json" 2>/dev/null; then
  while IFS=$'\t' read -r attr_name drv; do
    [ -n "$drv" ] || continue
    process_drv "$attr_name" "$drv"
  done < <(jq -r '.[] | [.attrName, (.drvPath // "")] | @tsv' "$entries_json")
else
  top_drv=$(nix path-info --derivation "$target_ref" 2>/dev/null || true)
  if [ -n "$top_drv" ]; then
    while IFS= read -r drv; do
      [ -n "$drv" ] || continue
      process_drv "" "$drv"
    done < <(nix-store -qR "$top_drv" 2>/dev/null | grep "pnpm-deps-[a-z0-9-]*-v[0-9].*\\.drv$" || true)
  fi
fi
