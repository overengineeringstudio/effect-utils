#!/usr/bin/env bash
set -euo pipefail

repo="${1:-$(git rev-parse --show-toplevel)}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/repo/packages/app" "$work/repo/packages/unrelated"
printf 'first\n' > "$work/repo/packages/app/source.txt"
printf 'unrelated\n' > "$work/repo/packages/unrelated/source.txt"
printf 'root\n' > "$work/repo/package.json"
cat > "$work/repo/source-manifest.json" <<'JSON'
{"products":{"fixture":{"sourcePaths":["package.json","packages/app"]}}}
JSON
export BUCK2_SOURCE_IDENTITY_REPO="$repo" BUCK2_SOURCE_IDENTITY_FIXTURE="$work/repo"
expr='
let
  repo = builtins.toPath (builtins.getEnv "BUCK2_SOURCE_IDENTITY_REPO");
  root = /. + (builtins.getEnv "BUCK2_SOURCE_IDENTITY_FIXTURE");
  flake = builtins.getFlake (toString repo);
  pkgs = import flake.inputs.nixpkgs {
    system = let selected = builtins.getEnv "BUCK2_SYSTEM"; in
      if selected == "" then builtins.currentSystem else selected;
  };
  sourcePaths = (builtins.fromJSON (builtins.readFile (root + "/source-manifest.json"))).products.fixture.sourcePaths;
  builder = import (repo + "/nix/buck2-products/from-source.nix") {
    inherit pkgs;
    buck2 = pkgs.writeShellScriptBin "buck2" "echo \"$PWD/packages/app/source.txt\"";
  };
  rootProjection = pkgs.runCommand "fixture-buck-root" {} "mkdir -p $out/.buck2 $out/buck2; touch $out/.buckconfig $out/.buckroot $out/BUCK";
  product = builder {
    inherit rootProjection sourcePaths;
    repositoryRoot = root;
    capabilities = pkgs.runCommand "fixture-capabilities" {} "mkdir -p $out";
    pnpmArchives = pkgs.runCommand "fixture-archives" {} "mkdir -p $out";
    product = { name = "fixture"; kind = "package"; target = "//packages/app:dist-package"; outputName = "fixture.txt"; };
  };
in product'
eval_path() { nix eval --impure --raw --expr "($expr).outPath"; }
first="$(eval_path)"
darwin_first="$(BUCK2_SYSTEM=aarch64-darwin eval_path)"
printf 'unrelated changed\n' > "$work/repo/packages/unrelated/source.txt"
second="$(eval_path)"
[[ "$first" == "$second" ]] || { echo "unrelated edit changed outPath: $first -> $second" >&2; exit 1; }
darwin_second="$(BUCK2_SYSTEM=aarch64-darwin eval_path)"
[[ "$darwin_first" == "$darwin_second" ]] || { echo 'unrelated edit changed Darwin outPath' >&2; exit 1; }
printf 'closure changed\n' > "$work/repo/packages/app/source.txt"
third="$(eval_path)"
[[ "$first" != "$third" ]] || { echo 'closure edit did not change outPath' >&2; exit 1; }
output="$(nix build --impure --no-link --print-out-paths --expr "$expr")"
[[ "$(cat "$output/fixture.txt")" == 'closure changed' ]]
nix-instantiate --eval --strict --json --expr "(let product = $expr; in product.passthru.sourceDigest)" | jq -e 'test("^[0-9a-f]{64}$")' >/dev/null
jq -e --arg target '//packages/app:dist-package' '(.schema == "effect-utils/buck-product-source-provenance/v1") and (.target == $target) and (.sourceDigest | test("^[0-9a-f]{64}$")) and (has("producerCommit") | not)' "$output/provenance.json" >/dev/null
printf 'unchanged=%s changed=%s sourceDigest=%s\n' "$second" "$third" "$(jq -r .sourceDigest "$output/provenance.json")"
