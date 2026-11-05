#!/usr/bin/env bash
# Best-effort cache warming, independent of artifact pins and promotion.
set -euo pipefail
repo_root="${1:-$PWD}"
cache=overeng-effect-utils
case "${GITHUB_EVENT_NAME:-}" in
  push|workflow_dispatch) ;;
  *) echo 'refusing compile publication outside a trusted main event' >&2; exit 1 ;;
esac
[[ "${GITHUB_REF:-}" == refs/heads/main &&
   "${GITHUB_REPOSITORY:-}" == overengineeringstudio/effect-utils ]] || exit 1

# Inspect this runner's package names without forcing unavailable products.
# Platform-filtered native exports must be skipped before realization.
available="$(nix eval --impure --json "$repo_root#packages" \
  --apply 'packages: builtins.attrNames packages.${builtins.currentSystem}')"

for inventory in cache compiled native; do
  names="$(jq -er '.products | map(.name) | join("\n")' "$repo_root/nix/buck2-products/$inventory-targets.json")"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    case "$inventory" in
      cache)
        safe_name="${name#@}"
        attr="buck-product-${safe_name//\//-}-from-source.compileProduct"
        ;;
      compiled) attr="$name-compiled.buck2Product.compileProduct" ;;
      native) attr="$name.buck2Product.compileProduct" ;;
    esac
    if ! jq -e --arg name "${attr%%.*}" 'index($name) != null' <<<"$available" >/dev/null; then
      echo "compile cache: skipping $attr (not exported on this system)"
      continue
    fi
    # Realizing the unstamped derivation substitutes when available, even when
    # the stamped artifact already substituted or its immutable pin was reused.
    if ! compile_path="$(nix build --no-link --print-out-paths "$repo_root#$attr")"; then
      echo "::warning title=Compile cache realization failed::$attr was not realized; publication and promotion are unaffected" >&2
      continue
    fi
    if [[ ! "$compile_path" =~ ^/nix/store/[0-9a-z]{32}-[A-Za-z0-9+._?=-]+$ || ! -d "$compile_path" ]]; then
      echo "::warning title=Compile cache output invalid::$attr did not produce one store directory; publication and promotion are unaffected" >&2
      continue
    fi
    # Always push the exact compile output, never a reused artifact-pin path.
    # These are replaceable substitutes, not immutable digest-named releases.
    if ! cachix push "$cache" "$compile_path"; then
      echo "::warning title=Compile cache push failed::$attr was not cached; publication and promotion are unaffected" >&2
    fi
  done <<< "$names"
done
