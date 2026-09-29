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

for inventory in nix/buck2-products/compiled-targets.json nix/buck2-products/native-targets.json; do
  names=$(jq -r '.products[].name' "$inventory")
  for name in $names; do
    attr="$name"
    if [ "$inventory" = nix/buck2-products/compiled-targets.json ]; then
      attr="$name-compiled"
    fi
    out=$(nix build --no-link --print-build-logs --print-out-paths ".#$attr")
    test -x "$out/bin/$name"
    "$out/bin/$name" --help >/dev/null
    echo "product $attr: $out"
    if [ "$push" = true ]; then
      cachix push overeng-effect-utils "$out"
    fi
  done
done
