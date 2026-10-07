#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
nix_bin="${NIX_BIN:-nix}"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
projection=packages/@overeng/megarepo/src/buck2-capabilities/capability-projection.ts
mkdir -p "$fixture/$(dirname "$projection")"
cp "$repo_root/$projection" "$fixture/$projection"
printf '%s\n' '{"capabilities":[{"toolId":"fixture","protocol":"fixture/v1","flakePackage":"fixture","executable":"bin/fixture"}]}' > "$fixture/buck2-member.json"

expression="let
  flake = builtins.getFlake \"${NIX_FLAKE_REF:-git+file://$repo_root?shallow=1}\";
  pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
in import $repo_root/nix/buck2-capabilities.nix {
  inherit pkgs;
  src = /. + \"$fixture\";
  capabilityPackages.fixture = pkgs.writeShellScriptBin \"fixture\" \"exit 0\";
}"
eval_path() {
  "$nix_bin" eval --impure --raw --expr "($expression).outPath"
}

before="$(eval_path)"
round_trip="$("$nix_bin" eval --impure --raw --expr "let base = $expression; in (import $repo_root/nix/buck2-capabilities.nix {
  pkgs = import (builtins.getFlake \"${NIX_FLAKE_REF:-git+file://$repo_root?shallow=1}\").inputs.nixpkgs { system = builtins.currentSystem; };
  inherit (base.passthru) src capabilityPackages;
}).outPath")"
[[ "$before" == "$round_trip" ]] || { echo 'Consumer capability source changed identity' >&2; exit 1; }
printf '%s\n' unrelated > "$fixture/ci-script.ts"
after="$(eval_path)"
[[ "$before" == "$after" ]] || { echo 'Unrelated source changed capability identity' >&2; exit 1; }
# This build is also the input-closure check: the real projection runs with no
# checkout files available except the two declared files and Nix package inputs.
"$nix_bin" build --impure --no-link --option builders "" --expr "$expression"
printf '\n' >> "$fixture/buck2-member.json"
changed="$(eval_path)"
[[ "$before" != "$changed" ]] || { echo 'Declared source did not change capability identity' >&2; exit 1; }

# An undeclared checkout read must fail, even if the file exists in the fixture.
printf '%s\n' secret > "$fixture/$(dirname "$projection")/undeclared.txt"
printf '\nawait readFile(new URL("./undeclared.txt", import.meta.url))\n' >> "$fixture/$projection"
if failure="$("$nix_bin" build --impure --no-link --option builders "" -L --expr "$expression" 2>&1)"; then
  echo 'Projection accepted an undeclared checkout read' >&2
  exit 1
fi
printf '%s\n' "$failure"
[[ "$failure" == *"ENOENT"* && "$failure" == *"undeclared.txt"* ]] || {
  echo 'Projection failed for a reason other than an undeclared checkout read' >&2
  exit 1
}
printf 'Capability source boundary: stable=%s sensitive=%s; undeclared reads rejected\n' "$before" "$changed"
