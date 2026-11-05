#!/usr/bin/env bash
#
# Build the exported Buck rules cell, retained shell, and compiled-executable
# and native products; smoke `bin/<name> --help` for inventoried products only.
# `--push` publishes each realized store path to the public Cachix cache
# (protected-main publisher only; needs CACHIX_AUTH_TOKEN).
#
# Product names are validated to [A-Za-z0-9._+-] by the Nix inventory loaders,
# so word splitting is safe; macOS runners ship Bash 3.2 (no `mapfile`).
set -euo pipefail

push=false
build_only=false
case "${1:-}" in
  '') ;;
  --push) push=true ;;
  --build-only) build_only=true ;;
  *)
    echo "usage: $0 [--push | --build-only]" >&2
    exit 2
    ;;
esac

# Use the same package graph as devenv's repoPackages. Evaluate it once for
# every inventoried import, the retained shell closure, and the Buck rules cell.
refs=(.#ci-test-shell-products .#buck2-rules)
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

if $build_only; then
  started=$SECONDS
  log=$(mktemp)
  trap 'rm -f "$log"' EXIT
  status=0
  nix build --no-link --print-build-logs --log-format raw --json "${refs[@]}" 2>&1 | tee "$log" || status=$?
  built=$(grep -c "^building '" "$log" || true)
  substituted=$(grep -c "^copying path '" "$log" || true)
  echo "product build: duration=$((SECONDS - started))s built=$built substituted=$substituted status=$status"
  exit "$status"
fi
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
  # its transitive closure, including the retained shell and Buck rules cell.
  cachix push overeng-effect-utils $outputs
fi
