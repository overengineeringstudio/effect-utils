#!/usr/bin/env bash
set -Eeuo pipefail

report_failure() {
  local status="$1"
  if [[ "$status" != 0 ]]; then
    printf 'from-source-cores: FAILED (exit %s) at line %s: %s\n' "$status" "$2" "$3" >&2
  fi
}
# ERR retains the command's actual line; LINENO in EXIT alone is always 1.
trap 'failure_line="$LINENO"; failure_command="$BASH_COMMAND"' ERR
trap 'report_failure "$?" "${failure_line:-unknown}" "${failure_command:-$BASH_COMMAND}"' EXIT

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
export BUCK2_PRODUCTS_REPO="$repo_root"
phase="$(nix eval --impure --raw --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_PRODUCTS_REPO");
    flake = builtins.getFlake ("git+file://" + toString repo + "?shallow=1");
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
# The shared buck_build command carries the budgets for all three output paths.
# Inspect the evaluated derivation, not the Nix source.
build_count=0
call_count=0
while IFS= read -r line; do
  if [[ "$line" == *' build '* ]]; then
    # Configuration overrides belong to the build subcommand, not global args.
    [[ "${line%% build *}" != *'--config'* ]]
    [[ "$line" == *' build -j "$NIX_BUILD_CORES" --config build.num_tokio_workers="$NIX_BUILD_CORES"'* ]]
    [[ "$line" == *'--local-only --no-remote-cache'* ]]
    build_count=$((build_count + 1))
  fi
  if [[ "$line" == *'="$(buck_build '* ]]; then
    call_count=$((call_count + 1))
  fi
done <<<"$phase"
[[ "$build_count" == 1 && "$call_count" == 3 ]] || {
  printf 'Expected one budgeted build command and three buck_build output calls; got %s and %s\n' "$build_count" "$call_count" >&2
  exit 1
}
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
