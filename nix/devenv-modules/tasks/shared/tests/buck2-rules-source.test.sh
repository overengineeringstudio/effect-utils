#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
nix_bin="${NIX_BIN:-nix}"
fixture="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$fixture"' EXIT

# The fixture checkout carries exactly the generated inventory's files plus one
# unrelated file, so the derivation's identity can only observe declared inputs.
inventory_file="$repo_root/nix/buck2-rules/inventory.json"
mapfile -t inventory_files < <("$nix_bin" eval --impure --json --expr "
  (builtins.fromJSON (builtins.readFile $(printf '%q' "$inventory_file"))).files
" | jq -r '.[]')
for path in "${inventory_files[@]}"; do
  mkdir -p "$fixture/$(dirname "$path")"
  cp "$repo_root/$path" "$fixture/$path"
done
printf '%s\n' 'unrelated' > "$fixture/unrelated-note.txt"

expression="let
  flake = builtins.getFlake \"${NIX_FLAKE_REF:-git+file://$repo_root?shallow=1}\";
  pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  buck2 = import $repo_root/nix/buck2.nix { inherit pkgs; };
  pnpmArchives = import $repo_root/nix/buck2-products/pnpm-archives.nix { inherit pkgs; };
in import $repo_root/nix/buck2-rules {
  inherit pkgs buck2 pnpmArchives;
  src = /. + \"$fixture\";
}"
eval_path() {
  "$nix_bin" eval --impure --raw --expr "($expression).outPath"
}

before="$(eval_path)"
printf '%s\n' 'changed unrelated content' > "$fixture/unrelated-note.txt"
after="$(eval_path)"
[[ "$before" == "$after" ]] || { echo 'Unrelated source changed buck2-rules identity' >&2; exit 1; }
printf '%s\n' 'sensitive' >> "$fixture/${inventory_files[0]}"
changed="$(eval_path)"
[[ "$before" != "$changed" ]] || { echo 'Declared source did not change buck2-rules identity' >&2; exit 1; }
printf 'buck2-rules source identity: stable=%s sensitive=%s\n' "$before" "$changed"
