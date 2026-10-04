# Inspect an extracted buck-build-product/v1 wasm guest without rewriting it.
{ pkgs }:

pkgs.writeShellScript "buck2-runtime-inspect-wasm-guest" ''
  set -euo pipefail
  export LC_ALL=C

  fail() {
    echo "buck2-runtime-inspect-wasm-guest: FATAL - $*" >&2
    exit 1
  }

  [ "$#" -eq 2 ] || fail "usage: $0 DESCRIPTOR_JSON EXTRACTED_ROOT"
  descriptor="$1"
  root="$2"
  [ -f "$descriptor" ] || fail "descriptor does not exist"
  [ -d "$root" ] || fail "extracted root does not exist"
  [ "$(${pkgs.jq}/bin/jq -r '.runtime.kind' "$descriptor")" = wasm-guest ] \
    || fail "descriptor runtime kind must be wasm-guest"
  [ "$(${pkgs.jq}/bin/jq -r '.runtime.inspectionContract' "$descriptor")" = wasm32-unknown-unknown/v1 ] \
    || fail "unsupported inspection contract"
  [ "$(${pkgs.jq}/bin/jq -r '.runtime.targetTriple' "$descriptor")" = wasm32-unknown-unknown ] \
    || fail "wasm guest target triple mismatch"

  inspect_entrypoint() {
    local relative="$1"
    local module="$root/$relative"
    [ -f "$module" ] && [ ! -L "$module" ] || fail "entrypoint must be a regular non-symlink file: $relative"
    local magic
    magic="$(${pkgs.coreutils}/bin/od -An -tx1 -N4 "$module" | ${pkgs.coreutils}/bin/tr -d ' ')"
    [ "$magic" = "0061736d" ] || fail "entrypoint is not a wasm module: $relative"
  }

  while IFS= read -r entrypoint; do
    inspect_entrypoint "$entrypoint"
  done < <(${pkgs.jq}/bin/jq -r '.entrypoints[]' "$descriptor")
''