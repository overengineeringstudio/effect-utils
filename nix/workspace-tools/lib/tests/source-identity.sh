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
  flake = builtins.getFlake ("git+file://" + toString repo + "?shallow=1");
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

# Exercise the actual retained shell graph from two different whole-checkout
# store roots and Git identities. This catches path interpolation retaining the
# parent flake context even when a recipe's advertised fileset is narrow.
mkdir -p "$work/shell"
while IFS= read -r -d '' path; do
  mkdir -p "$work/shell/$(dirname "$path")"
  cp "$repo/$path" "$work/shell/$path"
done < <(git -C "$repo" ls-files -z)
export BUCK2_SHELL_IDENTITY_FIXTURE="$work/shell"
export BUCK2_SHELL_IDENTITY_REV=1111111111111111111111111111111111111111
shell_expr='
let
  repo = builtins.toPath (builtins.getEnv "BUCK2_SOURCE_IDENTITY_REPO");
  pinned = builtins.getFlake ("git+file://" + toString repo + "?shallow=1");
  source = builtins.path {
    name = "shell-cache-fixture";
    path = builtins.toPath (builtins.getEnv "BUCK2_SHELL_IDENTITY_FIXTURE");
  };
  outputs = (import (source + "/flake.nix")).outputs (pinned.inputs // {
    self.sourceInfo = {
      rev = builtins.getEnv "BUCK2_SHELL_IDENTITY_REV";
      lastModified = 1;
    };
  });
  selected = builtins.getEnv "BUCK2_SYSTEM";
  system = if selected == "" then builtins.currentSystem else selected;
  packages = outputs.packages.${system};
  names = [
    "buck2" "buck2-capabilities" "buck2-archive-tool" "buck2-events"
    "buck2-fingerprint" "buck2-product" "otelite" "otel-scrape"
    "typescript-api-server"
    "netlify-cli" "vercel-cli" "pnpm" "oxlint-with-plugins"
  ];
in builtins.listToAttrs (map (name: {
  inherit name;
  value = packages.${name}.outPath;
}) names)'
shell_paths() { nix eval --impure --json --expr "$shell_expr"; }
linux_before="$(BUCK2_SYSTEM=x86_64-linux shell_paths)"
darwin_before="$(BUCK2_SYSTEM=aarch64-darwin shell_paths)"
printf 'unrelated commit\n' > "$work/shell/unrelated-cache-fixture.txt"
export BUCK2_SHELL_IDENTITY_REV=2222222222222222222222222222222222222222
[[ "$linux_before" == "$(BUCK2_SYSTEM=x86_64-linux shell_paths)" ]] || {
  echo 'unrelated commit changed retained Linux shell products' >&2; exit 1;
}
[[ "$darwin_before" == "$(BUCK2_SYSTEM=aarch64-darwin shell_paths)" ]] || {
  echo 'unrelated commit changed retained Darwin shell products' >&2; exit 1;
}
printf '\n// shell cache relevant source edit\n' >> "$work/shell/packages/@overeng/otelite/src/main.rs"
linux_after="$(BUCK2_SYSTEM=x86_64-linux shell_paths)"
jq -ne --argjson before "$linux_before" --argjson after "$linux_after" '
  $before.otelite != $after.otelite
  and $before["otel-scrape"] == $after["otel-scrape"]
  and $before["buck2-capabilities"] == $after["buck2-capabilities"]
' >/dev/null
[[ "$linux_before" != "$darwin_before" ]] || {
  echo 'native shell identity did not distinguish platform locks/toolchains' >&2; exit 1;
}
printf '\n// shell cache support-tool edit\n' >> "$work/shell/rust/buck2-tools/events/src/main.rs"
events_after="$(BUCK2_SYSTEM=x86_64-linux shell_paths)"
jq -ne --argjson before "$linux_after" --argjson after "$events_after" '
  $before["buck2-events"] != $after["buck2-events"]
  and $before["buck2-archive-tool"] == $after["buck2-archive-tool"]
  and $before.otelite == $after.otelite
' >/dev/null
printf '\n# shell cache lock input edit\n' >> "$work/shell/rust/Cargo.lock"
lock_after="$(BUCK2_SYSTEM=x86_64-linux shell_paths)"
jq -ne --argjson before "$events_after" --argjson after "$lock_after" '
  $before["buck2-events"] != $after["buck2-events"]
  and $before["buck2-archive-tool"] != $after["buck2-archive-tool"]
  and $before.otelite != $after.otelite
' >/dev/null
