#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
export BUCK2_PRODUCTS_REPO="$repo_root"
phase="$(nix eval --impure --raw --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_PRODUCTS_REPO");
    flake = builtins.getFlake (toString repo);
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    mkProduct = import (repo + "/nix/buck2-products/from-source.nix") {
      inherit pkgs;
      buck2 = pkgs.buck2;
    };
  in (mkProduct {
    capabilities = repo;
    pnpmArchives = repo;
    repositorySource = repo;
    runtimeClosureTarget = "root//:runtime";
    producerCommit = "0123456789abcdef0123456789abcdef01234567";
    product = {
      name = "core-budget-fixture";
      kind = "javascript";
      target = "root//:product";
      outputName = "artifact.tar";
    };
  }).buildPhase
')"
# Check all three build paths in the evaluated derivation, not the Nix source.
count=0
while IFS= read -r line; do
  if [[ "$line" == *' build '* ]]; then
    [[ "$line" == *'-j "$NIX_BUILD_CORES"'* ]]
    [[ "$line" == *'--config build.num_tokio_workers="$NIX_BUILD_CORES"'* ]]
    [[ "$line" == *'--local-only --no-remote-cache'* ]]
    count=$((count + 1))
  fi
done <<<"$phase"
[[ "$count" == 3 ]]
# Execute the actual generated normalization block for the Nix boundary cases.
prefix="${phase%%export HOME=*}"
for budget in unset 0 1 7; do
  actual="$(
    runHook() { :; }
    if [[ "$budget" == unset ]]; then unset NIX_BUILD_CORES; else export NIX_BUILD_CORES="$budget"; fi
    eval "$prefix"
    printf '%s:%s' "$NIX_BUILD_CORES" "$BUCK2_MAX_BLOCKING_THREADS"
  )"
  expected="$budget"
  [[ "$budget" != unset && "$budget" != 0 ]] || expected=1
  [[ "$actual" == "$expected:$expected" ]]
  printf 'NIX_BUILD_CORES=%s -> execution/runtime/blocking budget %s\n' "$budget" "$expected"
done
printf 'buck2 from-source core budget contracts passed\n'
