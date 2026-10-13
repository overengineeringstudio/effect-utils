#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
export BUCK2_PRODUCTS_REPO="$repo_root"
bash "$repo_root/nix/buck2-products/from-source-cores.test.sh" "$repo_root"
contract="$(nix eval --impure --json --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_PRODUCTS_REPO");
    flake = builtins.getFlake ("git+file://" + toString repo + "?shallow=1");
    system = builtins.currentSystem;
    packages = flake.packages.${system};
    product = packages.buck-product-megarepo-from-source;
    typescriptProduct = packages.buck-product-overeng-content-address-from-source;
  in {
    capabilities = toString product.capabilities;
    registeredCapabilities = toString packages.buck2-capabilities;
    pnpmArchives = toString product.pnpmArchives;
    registeredArchives = toString packages.buck2-pnpm-archives;
    hasPreparedDeps = product ? preparedDeps;
    hasStandaloneRoot = product ? standaloneRoot;
    source = toString product.source;
    typescriptBuildPhase = typescriptProduct.buildPhase;
    isLinux = flake.inputs.nixpkgs.lib.hasSuffix "-linux" system;
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

# Assert the production TypeScript recipe, not just the core-budget fixture.
# The outer Nix boundary does not admit these actions to Buck's remote cache.
typescript_build_phase="$(jq -r .typescriptBuildPhase <<<"$contract")"
is_linux="$(jq -r .isLinux <<<"$contract")"
typescript_build_count=0
while IFS= read -r line; do
  if [[ "$line" == *' build '* ]]; then
    [[ "$line" == *'--local-only --no-remote-cache'* ]]
    if [[ "$is_linux" == true ]]; then
      [[ "$line" == *'--config ts_action.outer_sandbox=nix-build/v1'* ]]
    else
      [[ "$line" != *'ts_action.outer_sandbox='* ]]
    fi
    typescript_build_count=$((typescript_build_count + 1))
  fi
done <<<"$typescript_build_phase"
[[ "$typescript_build_count" -ge 1 ]]

nix build "$repo_root#buck-product-megarepo-from-source" --no-link
# Rebuild even a cached output so nested Linux sandbox regressions cannot hide
# behind Nix substitution. This production package runs real TypeScript actions.
nix build "$repo_root#buck-product-overeng-content-address-from-source" --no-link
nix build "$repo_root#buck-product-overeng-content-address-from-source" --no-link --rebuild

# Source products must also build against the exported, local-cell consumer root.
"$repo_root/nix/buck2-rules/tests/consumer-root-contract.test.sh" "$repo_root"
bash "$repo_root/nix/workspace-tools/lib/tests/source-identity.sh" "$repo_root"
bash "$repo_root/nix/workspace-tools/lib/tests/cargo-release-profile.sh" "$repo_root"

printf 'buck2 from-source contracts passed\n'
