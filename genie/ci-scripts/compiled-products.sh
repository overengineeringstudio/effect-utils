#!/usr/bin/env bash
#
# Build compiled-executable and native products for this runner's platform
# through their source-backed Nix imports, then smoke `bin/<name> --help`.
# `--push` publishes each realized store path to the public Cachix cache
# (protected-main publisher only; needs CACHIX_AUTH_TOKEN).
#
# Product names are validated to [A-Za-z0-9._+-] by the Nix inventory loaders,
# so word splitting is safe; macOS runners ship Bash 3.2 (no `mapfile`).
set -euo pipefail

push=false
case "${1:-}" in
  '') ;;
  --push) push=true ;;
  *)
    echo "usage: $0 [--push]" >&2
    exit 2
    ;;
esac

# Use the same package graph as devenv's repoPackages. Evaluate it once for
# every inventoried import and the retained shell closure, not once per product.
refs=(.#ci-test-shell-products)
product_names=()
product_attrs=()
for inventory in nix/buck2-products/compiled-targets.json nix/buck2-products/native-targets.json; do
  names=$(jq -r '.products[].name' "$inventory")
  for name in $names; do
    attr="$name"
    if [ "$inventory" = nix/buck2-products/compiled-targets.json ]; then
      attr="$name-compiled"
    fi
    refs+=(".#$attr")
    product_names+=("$name")
    product_attrs+=("$attr")
  done
done
build_json=$(nix build --no-link --print-build-logs --json "${refs[@]}")
outputs=$(jq -er '.[] | .outputs.out // error("product build has no out output")' <<<"$build_json")

# Nix JSON reports derivations/outputs, not installable names. Match each
# inventory row by its executable rather than relying on result ordering.
# A missing or ambiguous import fails closed, preserving every smoke assertion.
for index in "${!product_names[@]}"; do
  name="${product_names[$index]}"
  attr="${product_attrs[$index]}"
  matches=0
  out=''
  for candidate in $outputs; do
    if [ -x "$candidate/bin/$name" ]; then
      out="$candidate"
      matches=$((matches + 1))
    fi
  done
  if [ "$matches" -ne 1 ]; then
    echo "product $attr: expected one executable output, found $matches" >&2
    exit 1
  fi
  "$out/bin/$name" --help >/dev/null
  echo "product $attr: $out"
done

if [ "$push" = true ]; then
  # Store paths contain no whitespace; publish every exact direct output and
  # its transitive closure, including the retained-shell aggregate.
  cachix push overeng-effect-utils $outputs
fi
