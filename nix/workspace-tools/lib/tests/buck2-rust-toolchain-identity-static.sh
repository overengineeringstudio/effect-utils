#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
nix_source="$repo_root/nix/workspace-tools/lib/buck2-rust-local-toolchain-config.nix"
buck_source="$repo_root/buck2/rust/local_store.bzl"
prelude_source="$repo_root/buck2/toolchains/nix_local.bzl"
devenv_source="$repo_root/devenv.nix"

extract_nix_keys() {
  local binding="$1"
  sed -n "/  $binding = builtins.concatStringsSep/,/  ];/p" "$nix_source" \
    | sed -n 's/^[[:space:]]*"\([a-z_]*\)=.*/\1/p'
}

extract_buck_keys() {
  local function="$1"
  local source="${2:-$buck_source}"
  sed -n "/def $function(ctx):/,/^def /p" "$source" \
    | sed -n 's/^[[:space:]]*"\([a-z_]*\)=".*/\1/p'
}

assert_same_keys() {
  local label="$1"
  local left="$2"
  local right="$3"
  [ "$left" = "$right" ] || {
    echo "buck2-rust-toolchain-identity-static: $label key mismatch" >&2
    diff -u <(printf '%s\n' "$left") <(printf '%s\n' "$right") >&2 || true
    exit 1
  }
}

config_keys="$(extract_nix_keys configIntegrityMaterial)"
compile_keys="$(extract_nix_keys compileMaterial)"
assert_same_keys config-integrity "$config_keys" "$(extract_buck_keys _config_integrity_material)"
assert_same_keys compile "$compile_keys" "$(extract_buck_keys _compile_identity_material)"
assert_same_keys conventional-compile "$compile_keys" "$(extract_buck_keys _compile_identity_material "$prelude_source")"

grep -F 'compiler = RunInfo(args = [' "$prelude_source" >/dev/null
grep -F 'ctx.attrs.identity_verifier' "$prelude_source" >/dev/null
grep -F 'ctx.attrs.compile_identity_material' "$prelude_source" >/dev/null
grep -F 'ctx.attrs.compile_identity' "$prelude_source" >/dev/null
grep -F 'ctx.attrs.rustc' "$prelude_source" >/dev/null
grep -F '//packages/@overeng/otel-scrape:product' "$devenv_source" >/dev/null
grep -F -- '--config rust_toolchain.compile_identity=sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' "$devenv_source" >/dev/null
grep -F 'false OTEL compile identity unexpectedly admitted' "$devenv_source" >/dev/null

expected_compile_keys='ar
cc
contract
cxx
execution_platform
linker
rustc
target_platform
target_triple
tool_path'
assert_same_keys compile-contract "$compile_keys" "$expected_compile_keys"

for irrelevant in clippy_driver dwp nm objcopy objdump python ranlib rustdoc strip; do
  grep -Fx "$irrelevant" <<<"$config_keys" >/dev/null
  if grep -Fx "$irrelevant" <<<"$compile_keys" >/dev/null; then
    echo "buck2-rust-toolchain-identity-static: irrelevant compile key admitted: $irrelevant" >&2
    exit 1
  fi
done

material_digest() {
  local ar="$1"
  local rustdoc="$2"
  local compile="ar=$ar;cc=/store/cc;contract=v1;cxx=/store/cxx;execution_platform=exec;linker=/store/ld;rustc=/store/rustc;target_platform=target;target_triple=triple;tool_path=/store/core/bin"
  local config="ar=$ar;cc=/store/cc;clippy_driver=/store/clippy;contract=v1;cxx=/store/cxx;dwp=/store/dwp;execution_platform=exec;identity_verifier=/store/verify;linker=/store/ld;nm=/store/nm;objcopy=/store/objcopy;objdump=/store/objdump;python=/store/python;ranlib=/store/ranlib;rustc=/store/rustc;rustdoc=$rustdoc;strip=/store/strip;target_platform=target;target_triple=triple;tool_path=/store/core/bin"
  printf '%s %s\n' "$(printf '%s' "$config" | sha256sum | awk '{print $1}')" "$(printf '%s' "$compile" | sha256sum | awk '{print $1}')"
}

read -r base_config base_compile < <(material_digest /store/ar /store/rustdoc)
read -r docs_config docs_compile < <(material_digest /store/ar /store/rustdoc-v2)
read -r ar_config ar_compile < <(material_digest /store/ar-v2 /store/rustdoc)

[ "$base_config" != "$docs_config" ]
[ "$base_compile" = "$docs_compile" ]
[ "$base_config" != "$ar_config" ]
[ "$base_compile" != "$ar_compile" ]

echo "buck2-rust-toolchain-identity-static: PASS irrelevant_rustdoc=stable relevant_ar=invalidates"
