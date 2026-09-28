#!/usr/bin/env bash
#
# Build every generated compiled-executable product
# (nix/buck2-products/compiled-targets.json) for this runner's platform through
# its `.#<name>-compiled` native import, then run `bin/<name> --help`.
# `--push` additionally pushes each realized import to the public Cachix cache
# (protected-main publisher only; needs CACHIX_AUTH_TOKEN).
#
# Product names are validated to [A-Za-z0-9._+-] by nix/buck2-products/compiled.nix,
# so word splitting is safe; no `mapfile` because macOS runners ship bash 3.2.
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

names=$(jq -r '.products[].name' nix/buck2-products/compiled-targets.json)
for name in $names; do
  out=$(nix build --no-link --print-build-logs --print-out-paths ".#$name-compiled")
  test -x "$out/bin/$name"
  "$out/bin/$name" --help >/dev/null
  echo "compiled product $name: $out"
  if [ "$push" = true ]; then
    cachix push overeng-effect-utils "$out"
  fi
done
