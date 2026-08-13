#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

while IFS=' ' read -r output_name tool_name; do
  tool_definition="$(sed -nE "/^    $tool_name = \{/{p;q;}" "$ROOT/nix/buck2-stage0-tools.nix")"
  if [ -z "$tool_definition" ]; then
    echo "FAIL: flake package $output_name references missing stage-0 tool $tool_name" >&2
    exit 1
  fi
done < <(
  sed -nE \
    's/^[[:space:]]*(buck2-[a-z0-9-]+) = buck2-stage0-tools\.([a-z0-9-]+);$/\1 \2/p' \
    "$ROOT/flake.nix"
)

inputs="$(nix eval --impure --json --expr "
  let
    flake = builtins.getFlake (toString $ROOT);
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    tools = import $ROOT/nix/buck2-stage0-tools.nix { inherit pkgs; };
  in builtins.mapAttrs (_: paths: map (path: pkgs.lib.removePrefix \"$ROOT/\" (toString path)) paths) tools.source-inputs
")"

assert_contains() {
  local tool="$1"
  local path="$2"
  jq -e --arg tool "$tool" --arg path "$path" '.[$tool] | index($path) != null' <<<"$inputs" >/dev/null
}

assert_excludes() {
  local tool="$1"
  local prefix="$2"
  if jq -e --arg tool "$tool" --arg prefix "$prefix" '.[$tool] | any(startswith($prefix))' <<<"$inputs" >/dev/null; then
    echo "FAIL: $tool source unexpectedly contains $prefix" >&2
    exit 1
  fi
}

assert_contains closure-tool rust/buck2-tools/core/Cargo.toml
assert_contains closure-tool rust/buck2-tools/closure-tool/Cargo.toml
assert_excludes closure-tool packages/@overeng/otelite
assert_excludes closure-tool packages/@overeng/otel-scrape
assert_excludes closure-tool rust/buck2-tools/package-evidence

echo "Buck stage-0 source input tests passed."
