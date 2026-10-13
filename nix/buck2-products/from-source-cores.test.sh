#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
export BUCK2_PRODUCTS_REPO="$repo_root"
contract="$(nix eval --impure --json --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_PRODUCTS_REPO");
    flake = builtins.getFlake ("git+file://" + toString repo + "?shallow=1");
    contractFor = system:
      let
        pkgs = import flake.inputs.nixpkgs { inherit system; };
        mkProduct = import (repo + "/nix/buck2-products/from-source.nix") {
          inherit pkgs;
          buck2 = pkgs.buck2;
        };
        product = mkProduct {
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
        };
      in {
        phase = product.buildPhase;
        isLinux = pkgs.stdenv.hostPlatform.isLinux;
      };
  in {
    current = contractFor builtins.currentSystem;
    linux = contractFor "x86_64-linux";
    darwin = contractFor "aarch64-darwin";
  }
')"
# Evaluate both platforms on every host; no cross-platform builds are needed.
for platform in current linux darwin; do
  phase="$(jq -r --arg platform "$platform" '.[$platform].phase' <<<"$contract")"
  is_linux="$(jq -r --arg platform "$platform" '.[$platform].isLinux' <<<"$contract")"
  # HOME and XDG state remain writable within the Nix build directory on both platforms.
  [[ "$phase" == *'export HOME="$TMPDIR/home"'* ]]
  [[ "$phase" == *'export XDG_CACHE_HOME="$TMPDIR/cache"'* ]]
  [[ "$phase" == *'export XDG_RUNTIME_DIR="$TMPDIR/runtime"'* ]]
  [[ "$phase" == *'mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" .buck2/capabilities'* ]]
  # The builder replaces any inherited home with its own build-local directory.
  environment_prefix="${phase%%export SSL_CERT_FILE=*}"
  for initial_home in /homeless-shelter /caller-home; do
    actual="$(
      runHook() { :; }
      export HOME="$initial_home" TMPDIR=/fixture-tmp NIX_BUILD_CORES=1
      eval "$environment_prefix"
      printf '%s:%s:%s' "$HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
    )"
    [[ "$actual" == "/fixture-tmp/home:/fixture-tmp/cache:/fixture-tmp/runtime" ]]
  done
  # Check all three build paths in the evaluated derivation, not the Nix source.
  count=0
  while IFS= read -r line; do
    if [[ "$line" == *' build '* ]]; then
      # Configuration overrides belong to the build subcommand, not global args.
      [[ "${line%% build *}" != *'--config'* ]]
      [[ "$line" == *' build -j "$NIX_BUILD_CORES" --config build.num_tokio_workers="$NIX_BUILD_CORES"'* ]]
      [[ "$line" == *'--local-only --no-remote-cache'* ]]
      if [[ "$is_linux" == true ]]; then
        [[ "$line" == *'--config ts_action.outer_sandbox=nix-build/v1'* ]]
      else
        [[ "$line" != *'ts_action.outer_sandbox='* ]]
      fi
      count=$((count + 1))
    fi
  done <<<"$phase"
  [[ "$count" == 3 ]]
done
# Execute the actual generated normalization block for the Nix boundary cases.
phase="$(jq -r .current.phase <<<"$contract")"
prefix="${phase%%export XDG_CACHE_HOME=*}"
for budget in unset 0 1 7; do
  actual="$(
    runHook() { :; }
    export TMPDIR="${TMPDIR:-/tmp}"
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
