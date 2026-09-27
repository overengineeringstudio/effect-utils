#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
export BUCK2_PRODUCTS_REPO="$repo_root"
contract="$(nix eval --impure --json --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_PRODUCTS_REPO");
    flake = builtins.getFlake (toString repo);
    system = builtins.currentSystem;
    packages = flake.packages.${system};
    product = packages.buck-product-megarepo-from-source;
  in {
    capabilities = toString product.capabilities;
    registeredCapabilities = toString packages.buck2-capabilities;
    pnpmArchives = toString product.pnpmArchives;
    registeredArchives = toString packages.buck2-pnpm-archives;
    hasPreparedDeps = product ? preparedDeps;
    hasStandaloneRoot = product ? standaloneRoot;
    source = toString product.source;
  }
')"
capabilities="$(jq -r .capabilities <<<"$contract")"
registered_capabilities="$(jq -r .registeredCapabilities <<<"$contract")"
pnpm_archives="$(jq -r .pnpmArchives <<<"$contract")"
registered_archives="$(jq -r .registeredArchives <<<"$contract")"
has_prepared_deps="$(jq -r .hasPreparedDeps <<<"$contract")"
has_standalone_root="$(jq -r .hasStandaloneRoot <<<"$contract")"
source="$(jq -r .source <<<"$contract")"

[[ "$capabilities" == "$registered_capabilities" ]] || {
  printf 'megarepo source product did not select the registered capability projection\n' >&2
  exit 1
}
[[ "$pnpm_archives" == "$registered_archives" ]] || {
  printf 'megarepo source product did not select the registered per-digest archives\n' >&2
  exit 1
}
[[ "$has_prepared_deps" == false ]]
[[ "$has_standalone_root" == false ]]
[[ -d "$source/genie/weaver-registry" ]]
[[ -f "$source/nix/weaver-flake/flake.nix" ]]
[[ -f "$source/.buckconfig" ]]
[[ -f "$source/buck2/dependencies/BUCK" ]]

nix build "$repo_root#buck-product-megarepo-from-source" --no-link

printf 'buck2 from-source contracts passed\n'
