#!/usr/bin/env bash
set -euo pipefail
repo="${1:-$(git rev-parse --show-toplevel)}"
mkdir -p "$repo/tmp"
work="$(mktemp -d "$repo/tmp/helper-identity.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/source"
while IFS= read -r -d '' file; do
  mkdir -p "$work/source/$(dirname "$file")"
  cp "$repo/$file" "$work/source/$file"
done < <(git -C "$repo" ls-files -z)
export HELPER_IDENTITY_REPO="$repo" HELPER_IDENTITY_SOURCE="$work/source"
paths() {
  nix eval --impure --json \
    --option allow-import-from-derivation false --expr '
    let
      pinned = builtins.getFlake ("git+file://" + builtins.getEnv "HELPER_IDENTITY_REPO" + "?shallow=1");
      source = builtins.path { path = builtins.toPath (builtins.getEnv "HELPER_IDENTITY_SOURCE"); name = "source"; };
      outputs = (import (source + "/flake.nix")).outputs (pinned.inputs // {
        self.sourceInfo = { rev = "1111111111111111111111111111111111111111"; lastModified = 1; };
      });
    in builtins.listToAttrs (map (name: let
      product = outputs.packages.x86_64-linux."buck-product-${name}-from-source";
    in { inherit name; value = {
      drvPath = product.compileProduct.drvPath;
      inherit (product) recipeIdentity;
    }; }) [ "genie" "megarepo" ])'
}
before="$(paths)"
helper="$work/source/packages/@overeng/buck2-tools"
printf '\n// unrelated test mutation\n' >> "$helper/src/editor-view-sharing.integration.test.ts"
printf '\n// unrelated validation mutation\n' >> "$helper/src/repository-validation-runner.ts"
unrelated="$(paths)"
[[ "$before" == "$unrelated" ]] || { echo 'non-production helper edits changed compile identities' >&2; exit 1; }
while read -r file; do
  cp "$helper/$file" "$work/original"
  chmod u+w "$helper/$file"
  printf '\n' >> "$helper/$file"
  changed="$(paths)"
  jq -ne --argjson before "$before" --argjson after "$changed" \
    'all($before | keys[]; . as $name | $before[$name].drvPath != $after[$name].drvPath
      and $before[$name].recipeIdentity != $after[$name].recipeIdentity)' >/dev/null
  cp "$work/original" "$helper/$file"
  jq -n --arg control "$file" --argjson before "$before" --argjson after "$changed" \
    '{control:$control,before:$before,after:$after}'
done <<'CONTROLS'
src/package-tree.ts
src/typescript-runner.ts
src/editor-view-lifecycle.ts
package.json
tsconfig.json
CONTROLS
jq -n --argjson before "$before" --argjson after "$unrelated" \
  '{control:"test and repository validation edits",before:$before,after:$after}'
