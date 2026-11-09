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
# Opaque rule outputs cannot prove membership; the scoped fileset must own the entry.
if eval_path >"$work/missing-entry.log" 2>&1; then
  echo 'missing entry BUCK was accepted' >&2; exit 1
fi
[[ "$(<"$work/missing-entry.log")" == *'entry package BUCK missing from product projection'* ]]
printf '# fixture entry package\n' > "$work/repo/packages/app/BUCK"
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
  jsIdentity = builtins.getEnv "BUCK2_JS_IDENTITY" == "1";
  names = if jsIdentity then [
    "ai-gateway-edge" "ci-tools" "gh-ci-utils" "notion-cli" "notion-db-runtime" "tui-stories"
  ] else [
    "buck2" "buck2-capabilities" "buck2-archive-tool" "buck2-events"
    "buck2-fingerprint" "buck2-product" "otelite" "otel-scrape"
    "typescript-api-server" "ci-tools-compiled"
    "netlify-cli" "vercel-cli" "pnpm" "oxlint-with-plugins"
  ];
in builtins.listToAttrs (map (name: {
  inherit name;
  value = if jsIdentity then packages."buck-product-${name}-from-source".compileProduct.drvPath
    else packages.${name}.outPath;
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
# Stage-0 tools use committed projected locks, so an unrelated root lock edit
# must preserve their identities while still invalidating root-lock consumers.
printf '\n# shell cache lock input edit\n' >> "$work/shell/rust/Cargo.lock"
lock_after="$(BUCK2_SYSTEM=x86_64-linux shell_paths)"
jq -ne --argjson before "$events_after" --argjson after "$lock_after" '
  $before["buck2-events"] == $after["buck2-events"]
  and $before["buck2-archive-tool"] == $after["buck2-archive-tool"]
  and $before.otelite != $after.otelite
' >/dev/null

# Fingerprint is a real npm emission proof, not an input to native/compiled
# packaging. A helper edit must still invalidate the required packager.
printf '\n// fingerprint capability closure control\n' >> "$work/shell/rust/buck2-tools/fingerprint/src/lib.rs"
fingerprint_after="$(BUCK2_SYSTEM=x86_64-linux shell_paths)"
jq -ne --argjson before "$lock_after" --argjson after "$fingerprint_after" '
  $before["buck2-fingerprint"] != $after["buck2-fingerprint"]
  and $before["buck2-product"] == $after["buck2-product"]
  and $before["buck2-archive-tool"] == $after["buck2-archive-tool"]
  and $before["buck2-events"] == $after["buck2-events"]
  and $before.otelite == $after.otelite
  and $before["otel-scrape"] == $after["otel-scrape"]
  and $before["typescript-api-server"] == $after["typescript-api-server"]
  and $before["ci-tools-compiled"] == $after["ci-tools-compiled"]
' >/dev/null
printf '\n// core helper capability closure control\n' >> "$work/shell/rust/buck2-tools/core/src/lib.rs"
core_after="$(BUCK2_SYSTEM=x86_64-linux shell_paths)"
jq -ne --argjson before "$fingerprint_after" --argjson after "$core_after" '
  $before["buck2-product"] != $after["buck2-product"]
  and $before["buck2-archive-tool"] != $after["buck2-archive-tool"]
  and $before["buck2-fingerprint"] == $after["buck2-fingerprint"]
  and $before["buck2-events"] == $after["buck2-events"]
  and $before.otelite != $after.otelite
  and $before["typescript-api-server"] != $after["typescript-api-server"]
  and $before["ci-tools-compiled"] != $after["ci-tools-compiled"]
' >/dev/null

# Plugin source still keys the compile output even though publication stamps do not.
printf '\n// shell plugin source control\n' >> "$work/shell/packages/@overeng/oxc-config/src/mod.ts"
plugin_after="$(BUCK2_SYSTEM=x86_64-linux shell_paths)"
jq -ne --argjson before "$core_after" --argjson after "$plugin_after" '
  $before["oxlint-with-plugins"] != $after["oxlint-with-plugins"]
  and $before["buck2-capabilities"] != $after["buck2-capabilities"]
  and $before.otelite == $after.otelite
' >/dev/null

# One package graph per bounded evaluation: never retain several whole-flake
# source variants together. Root-projection separately covers rule sensitivity.
js_paths() {
  BUCK2_JS_IDENTITY=1 BUCK2_SYSTEM=x86_64-linux timeout 600 \
    nix eval --impure --option allow-import-from-derivation false --json --expr "$shell_expr"
}
export BUCK2_SHELL_IDENTITY_REV=1111111111111111111111111111111111111111
js_before="$(js_paths)"
printf '\nJS cache unrelated context edit\n' >> "$work/shell/context/pingping/spec.md"
export BUCK2_SHELL_IDENTITY_REV=2222222222222222222222222222222222222222
js_after="$(js_paths)"
[[ "$js_before" == "$js_after" ]] || {
  echo 'context-only edit and producer revision changed scoped JS compile recipes' >&2; exit 1;
}
# ai-gateway-edge does not declare megarepo (unlike tui-stories).
cp "$work/shell/packages/@overeng/megarepo/src/mod.ts" "$work/js-unrelated-source"
printf '\n// unrelated package source control\n' >> "$work/shell/packages/@overeng/megarepo/src/mod.ts"
js_unrelated="$(js_paths)"
jq -ne --argjson before "$js_after" --argjson after "$js_unrelated" \
  '$before["ai-gateway-edge"] == $after["ai-gateway-edge"]' >/dev/null || {
  echo 'unrelated megarepo source edit changed ai-gateway-edge compile recipe' >&2; exit 1;
}
cp "$work/js-unrelated-source" "$work/shell/packages/@overeng/megarepo/src/mod.ts"
# Each real own-source mutation must invalidate its product, not just the
# publication wrapper. Restore between controls so failures name one input.
while read -r name relative; do
  cp "$work/shell/$relative" "$work/js-source"
  printf '\n// JS compile identity source control\n' >> "$work/shell/$relative"
  changed="$(js_paths)"
  jq -ne --arg name "$name" --argjson before "$js_after" --argjson after "$changed" \
    '$before[$name] != $after[$name]' >/dev/null || {
    echo "own source edit did not change $name compile recipe: $relative" >&2; exit 1;
  }
  cp "$work/js-source" "$work/shell/$relative"
done <<'SOURCES'
ai-gateway-edge packages/@overeng/ai-gateway-edge/src/mod.ts
ci-tools packages/@overeng/ci-tools/src/mod.ts
gh-ci-utils packages/@overeng/gh-ci-utils/src/mod.ts
notion-cli packages/@overeng/notion-cli/src/mod.ts
notion-db-runtime packages/@overeng/notion-datasource-sync/src/cli/main.ts
tui-stories packages/@overeng/tui-stories/src/mod.ts
SOURCES
