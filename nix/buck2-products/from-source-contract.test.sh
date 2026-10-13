#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
export BUCK2_PRODUCTS_REPO="$repo_root"
# Each probe records a new sandbox, not a cached or --rebuild-compared snapshot.
if [[ "$(uname -s)" == Linux ]]; then
  IFS= read -r BUCK2_OUTER_SANDBOX_PROBE_INVOCATION </proc/sys/kernel/random/uuid
  export BUCK2_OUTER_SANDBOX_PROBE_INVOCATION
else
  bash "$repo_root/nix/buck2-products/from-source-cores.test.sh" "$repo_root"
fi
contract="$(nix eval --impure --json --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_PRODUCTS_REPO");
    flake = builtins.getFlake ("git+file://" + toString repo + "?shallow=1");
    system = builtins.currentSystem;
    packages = flake.packages.${system};
    product = packages.buck-product-megarepo-from-source;
    typescriptProduct = packages.buck-product-overeng-content-address-from-source;
    isLinux = flake.inputs.nixpkgs.lib.hasSuffix "-linux" system;
    outerSandboxProbe = import (repo + "/nix/buck2-products/outer-sandbox-probe.nix") {
      pkgs = import flake.inputs.nixpkgs { inherit system; };
      invocation = builtins.getEnv "BUCK2_OUTER_SANDBOX_PROBE_INVOCATION";
    };
  in {
    capabilities = toString product.capabilities;
    registeredCapabilities = toString packages.buck2-capabilities;
    pnpmArchives = toString product.pnpmArchives;
    registeredArchives = toString packages.buck2-pnpm-archives;
    hasPreparedDeps = product ? preparedDeps;
    hasStandaloneRoot = product ? standaloneRoot;
    source = toString product.source;
    typescriptBuildPhase = typescriptProduct.buildPhase;
    typescriptIsFixedOutput = typescriptProduct ? outputHash;
    typescriptDisablesSandbox = typescriptProduct.__noChroot or false;
    inherit isLinux;
    outerSandboxProbe = if isLinux then toString outerSandboxProbe.drvPath else null;
  }
')"
is_linux="$(jq -r .isLinux <<<"$contract")"
if [[ "$is_linux" == true ]]; then
  probe_drv="$(jq -r .outerSandboxProbe <<<"$contract")"
  printf 'BUCK2_OUTER_SANDBOX_PROBE_BUILD %s invocation=%s\n' \
    "$probe_drv" "$BUCK2_OUTER_SANDBOX_PROBE_INVOCATION"
  # Strict, non-FOD, no-network Nix execution precedes any product/runtime checks.
  # The UUID changes the derivation identity on every run, forcing fresh evidence
  # without --rebuild's comparison of inherently different mount IDs/build paths.
  probe_output="$(nix build "$probe_drv^*" --no-link --print-out-paths -L \
    --option sandbox true --option sandbox-fallback false)"
  # Keep a plain, searchable copy in the GitHub job log even if build logs are
  # hidden by substitution or Nix's progress renderer.
  printf 'BUCK2_OUTER_SANDBOX_PROBE_RETAINED_EVIDENCE_BEGIN %s\n' "$probe_output"
  cat "$probe_output/evidence.json"
  printf 'BUCK2_OUTER_SANDBOX_PROBE_RETAINED_EVIDENCE_END\n'
  bash "$repo_root/nix/buck2-products/from-source-cores.test.sh" "$repo_root"
fi
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
# Runtime verification, not the declaration, permits omitting nested Bubblewrap.
# This outer boundary still does not admit actions to Buck's remote cache.
typescript_build_phase="$(jq -r .typescriptBuildPhase <<<"$contract")"
[[ "$(jq -r .typescriptIsFixedOutput <<<"$contract")" == false ]]
[[ "$(jq -r .typescriptDisablesSandbox <<<"$contract")" == false ]]
[[ "$typescript_build_phase" == *'export HOME="$TMPDIR/home"'* ]]
[[ "$typescript_build_phase" == *'mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" .buck2/capabilities'* ]]
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

# Require a real non-FOD sandbox on Linux even if the caller's Nix configuration
# defaults to sandbox=false or relaxed. The action launcher must still verify it;
# these flags do not bypass verification. Preserve Darwin's sandbox policy.
sandbox_args=()
if [[ "$is_linux" == true ]]; then
  sandbox_args+=(--option sandbox true --option sandbox-fallback false)
fi
nix build "$repo_root#buck-product-megarepo-from-source" --no-link "${sandbox_args[@]}"
# Create the output, then rebuild even when cached so substitution cannot hide
# verifier failures. This non-FOD production package runs real TypeScript actions.
nix build "$repo_root#buck-product-overeng-content-address-from-source" --no-link "${sandbox_args[@]}"
nix build "$repo_root#buck-product-overeng-content-address-from-source" --no-link --rebuild "${sandbox_args[@]}"

# Source products must also build against the exported, local-cell consumer root.
"$repo_root/nix/buck2-rules/tests/consumer-root-contract.test.sh" "$repo_root"
bash "$repo_root/nix/workspace-tools/lib/tests/source-identity.sh" "$repo_root"
bash "$repo_root/nix/workspace-tools/lib/tests/cargo-release-profile.sh" "$repo_root"

printf 'buck2 from-source contracts passed\n'
