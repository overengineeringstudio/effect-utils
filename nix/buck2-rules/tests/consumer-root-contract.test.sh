#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)}"
export BUCK2_RULES_REPO="$repo_root"

root="$(nix build --impure --no-link --print-out-paths --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_RULES_REPO");
    flake = builtins.getFlake (toString repo);
    system = builtins.currentSystem;
    pkgs = import flake.inputs.nixpkgs { inherit system; };
  in flake.lib.mkConsumerBuckRoot {
    inherit pkgs;
    rules = flake.packages.${system}.buck2-rules;
    capabilities = flake.packages.${system}.buck2-capabilities;
    cellName = "fixture";
  }
')"

[ -f "$root/.buckroot" ]
[ -f "$root/.buckconfig" ]
[ -f "$root/BUCK" ]
[ -f "$root/buck2/toolchains/BUCK" ]
[ -f "$root/.buck2/rules/inventory.json" ]
[ -f "$root/.buck2/rules/prelude/prelude.bzl" ]
[ -f "$root/.buck2/capabilities/defs.bzl" ]
[ -f "$root/.buck2/rules/packages/@overeng/buck2-tools/src/typescript-runner.ts" ]

config="$(cat "$root/.buckconfig")"
printf '%s\n' "$config" | grep -F 'fixture = .' >/dev/null
printf '%s\n' "$config" | grep -F 'rules = .buck2/rules' >/dev/null
printf '%s\n' "$config" | grep -F 'capabilities = .buck2/capabilities' >/dev/null
printf '%s\n' "$config" | grep -F 'prelude = .buck2/rules/prelude' >/dev/null
printf '%s\n' "$config" | grep -F 'toolchains = fixture' >/dev/null
printf '%s\n' "$config" | grep -F 'remote_cache_enabled = false' >/dev/null
printf '%s\n' "$config" | grep -F 'allow_cache_uploads = false' >/dev/null
if printf '%s\n' "$config" | grep -F '[buck2_re_client]' >/dev/null; then
  echo 'default consumer root unexpectedly configures a remote client' >&2
  exit 1
fi
if printf '%s\n' "$config" | grep -F '[archive_origin]' >/dev/null; then
  echo 'default consumer root unexpectedly configures an archive origin' >&2
  exit 1
fi

private_config="$(nix eval --raw --impure --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_RULES_REPO");
    flake = builtins.getFlake (toString repo);
    system = builtins.currentSystem;
    pkgs = import flake.inputs.nixpkgs { inherit system; };
  in (flake.lib.mkConsumerBuckRoot {
    inherit pkgs;
    rules = flake.packages.${system}.buck2-rules;
    capabilities = flake.packages.${system}.buck2-capabilities;
    cellName = "fixture";
    remoteCacheEnabled = true;
    allowCacheUploads = true;
    actionCacheAddress = "https://actions.example.invalid";
    casAddress = "https://cas.example.invalid";
    cacheInstanceName = "fixture-private";
    cacheTls = true;
    archiveOriginUrlPrefix = "https://archives.example.invalid/cas/";
    archiveOriginTier = "private";
  }).buckConfig
')"
printf '%s\n' "$private_config" | grep -F 'remote_cache_enabled = true' >/dev/null
printf '%s\n' "$private_config" | grep -F 'allow_cache_uploads = true' >/dev/null
printf '%s\n' "$private_config" | grep -F 'action_cache_address = https://actions.example.invalid' >/dev/null
printf '%s\n' "$private_config" | grep -F 'cas_address = https://cas.example.invalid' >/dev/null
printf '%s\n' "$private_config" | grep -F 'instance_name = fixture-private' >/dev/null
printf '%s\n' "$private_config" | grep -F 'tls = true' >/dev/null
printf '%s\n' "$private_config" | grep -F 'url_prefix = https://archives.example.invalid/cas/' >/dev/null
printf '%s\n' "$private_config" | grep -F 'trusted_tier = private' >/dev/null
if printf '%s\n' "$config" | grep -F 'effect_utils' >/dev/null; then
  echo 'consumer root must not mount effect-utils' >&2
  exit 1
fi
if printf '%s\n' "$config" | grep -F '/nix/store/' >/dev/null; then
  echo 'consumer root cell paths must be materialized root-relative paths' >&2
  exit 1
fi

grep -F 'load("@rules//buck2/toolchains:defs.bzl"' "$root/buck2/toolchains/BUCK" >/dev/null
grep -F 'load("@capabilities//:defs.bzl"' "$root/buck2/toolchains/BUCK" >/dev/null
grep -F 'effect_tsgo_toolchain(' "$root/buck2/toolchains/BUCK" >/dev/null
grep -F 'name = "product_tool"' "$root/buck2/toolchains/BUCK" >/dev/null
grep -F 'actual = "//buck2/toolchains:rust"' "$root/BUCK" >/dev/null
grep -F 'name = "packages/@overeng/buck2-tools/src/typescript-runner.ts"' "$root/.buck2/rules/BUCK" >/dev/null
grep -F 'name = "package_tree_runtime"' "$root/.buck2/rules/BUCK" >/dev/null
grep -F 'name = "package_command_runtime"' "$root/.buck2/rules/BUCK" >/dev/null

(
  cd "$root"
  buck2 --isolation-dir consumer-root-contract uquery \
    'set(rules//:package_tree_runtime rules//:package_command_runtime rules//:packages/@overeng/buck2-tools/src/typescript-runner.ts)' >/dev/null
  buck2 --isolation-dir consumer-root-contract cquery \
    'fixture//buck2/toolchains:effect_tsgo' >/dev/null
)

echo 'buck2 consumer root contract passed'
