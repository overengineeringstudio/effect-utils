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

compile_refs=()
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
    compile_refs+=("$repo_root#$attr")
  done <<< "$names"
done

[[ ${#compile_refs[@]} -gt 0 ]] || exit 0
# One realization lets Nix schedule the unstamped derivations together, even
# when stamped artifacts already substituted or their immutable pins were reused.
if ! compile_outputs="$(nix build --no-link --print-out-paths --keep-going "${compile_refs[@]}")"; then
  echo '::warning title=Compile cache realization failed::Some compile outputs were not realized; publication and promotion are unaffected' >&2
  # Failed builds need not print successful outputs. Query only the selected
  # attributes for valid realized paths; path-info does not build missing ones.
  compile_outputs=''
  for ref in "${compile_refs[@]}"; do
    if compile_path="$(nix path-info "$ref")"; then
      compile_outputs+="$compile_path"$'\n'
    else
      echo "::warning title=Compile cache realization failed::$ref was not realized; publication and promotion are unaffected" >&2
    fi
  done
fi

compile_paths=()
while IFS= read -r compile_path; do
  [[ -n "$compile_path" ]] || continue
  if [[ ! "$compile_path" =~ ^/nix/store/[0-9a-z]{32}-[A-Za-z0-9+._?=-]+$ || ! -d "$compile_path" ]]; then
    echo "::warning title=Compile cache output invalid::$compile_path is not a store directory; publication and promotion are unaffected" >&2
    continue
  fi
  compile_paths+=("$compile_path")
done <<< "$compile_outputs"

# Push exact compile outputs only, never reused artifact-pin paths or store scans.
# These are replaceable substitutes, not immutable digest-named releases.
if [[ ${#compile_paths[@]} -gt 0 ]] && ! cachix push "$cache" "${compile_paths[@]}"; then
  echo '::warning title=Compile cache push failed::Compile outputs were not cached; publication and promotion are unaffected' >&2
fi
