#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
bun="${BUCK2_PRODUCTS_BUN:-bun}"

"$bun" "$repo_root/nix/buck2-products/rewrite-package-tree.contract.mjs"

export BUCK2_PRODUCTS_REPO="$repo_root"
contract="$(nix eval --impure --json --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_PRODUCTS_REPO");
    flake = builtins.getFlake (toString repo);
    system = builtins.currentSystem;
    packages = flake.packages.${system};
    product = packages.buck-product-megarepo-from-source;
  in {
    preparedDeps = toString product.preparedDeps;
    registryDeps = toString packages.megarepo-source-product-pnpm-deps;
    source = toString product.source;
  }
')"
prepared_deps="$(jq -r .preparedDeps <<<"$contract")"
registry_deps="$(jq -r .registryDeps <<<"$contract")"
source="$(jq -r .source <<<"$contract")"

[[ "$prepared_deps" == "$registry_deps" ]] || {
  printf 'megarepo source product did not select its registry dependency projection\n' >&2
  exit 1
}
[[ -d "$source/genie/weaver-registry" ]]
[[ -f "$source/nix/weaver-flake/flake.nix" ]]

standalone_root="$(nix build --impure --no-link --print-out-paths --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_PRODUCTS_REPO");
    flake = builtins.getFlake (toString repo);
  in flake.packages.${builtins.currentSystem}.buck-product-megarepo-from-source.standaloneRoot
')"

[[ -f "$standalone_root/.buckroot" ]]
grep -F 'capabilities = .buck2/capabilities' "$standalone_root/.buckconfig" >/dev/null
grep -F 'load("@capabilities//:defs.bzl", "CAPABILITIES", "GENERATION")' \
  "$standalone_root/buck2/toolchains/BUCK" >/dev/null
grep -F 'CAPABILITIES = {' "$standalone_root/.buck2/capabilities/defs.bzl" >/dev/null
grep -F '"executableStorePath": "/nix/store/' \
  "$standalone_root/.buck2/capabilities/defs.bzl" >/dev/null
if grep -F '@bunDigest@' "$standalone_root/.buck2/capabilities/defs.bzl" >/dev/null; then
  printf 'standalone capability projection retained an unresolved Bun digest\n' >&2
  exit 1
fi

printf 'buck2 from-source contracts passed\n'
