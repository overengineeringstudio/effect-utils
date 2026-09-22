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

(
  cd "$root"
  buck2 --isolation-dir consumer-root-contract query \
    '@rules//:packages/@overeng/buck2-tools/src/typescript-runner.ts' >/dev/null
)

echo 'buck2 consumer root contract passed'
