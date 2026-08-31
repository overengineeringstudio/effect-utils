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
    flake = builtins.getFlake \"$NIX_FLAKE_REF\";
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    tools = import $ROOT/nix/buck2-stage0-tools.nix { inherit pkgs; };
  in builtins.mapAttrs (_: paths: map (path: pkgs.lib.removePrefix \"$ROOT/\" (toString path)) paths) tools.source-inputs
")"

jq -e '
  (keys | sort) == ["archive-tool", "product"]
' <<<"$inputs" >/dev/null || {
  echo "FAIL: support-tool source inventory is incomplete or has unknown tools" >&2
  exit 1
}

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

for tool in archive-tool product; do
  assert_contains "$tool" rust/Cargo.toml
  assert_contains "$tool" rust/Cargo.lock
  assert_contains "$tool" rust-toolchain.toml
  assert_contains "$tool" rust/buck2-tools/core/Cargo.toml
  assert_contains "$tool" "rust/buck2-tools/$tool/Cargo.toml"
  assert_excludes "$tool" packages/@overeng/otelite
  assert_excludes "$tool" packages/@overeng/otel-scrape
  for sibling in archive-tool product; do
    if [ "$sibling" != "$tool" ]; then
      assert_excludes "$tool" "rust/buck2-tools/$sibling/src"
    fi
  done
done

echo "Buck support-tool source input tests passed."
