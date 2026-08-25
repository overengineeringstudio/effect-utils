#!/usr/bin/env bash
set -euo pipefail
# Buck local actions must run the exact Nix-authored toolchain; an ambient
# RUSTC_WRAPPER (e.g. sccache) breaks on Buck scratch paths and violates that
# contract, so strip it before any buck2 invocation.
unset RUSTC_WRAPPER RUSTC_BUILD_WRAPPER

mode="${1:?usage: buck2-otel-scrape-nix-admission.sh smoke|admit TOOLCHAIN_CONFIG}"
toolchain_config="${2:?Rust toolchain config is required}"
repo_root="${DEVENV_ROOT:-$PWD}"
buck2_bin="${BUCK2_BIN:?BUCK2_BIN is required}"
nix_bin="${NIX_BIN:?NIX_BIN is required}"
jq_bin="${JQ_BIN:?JQ_BIN is required}"
awk_bin="${AWK_BIN:?AWK_BIN is required}"
isolation="otel-scrape-nix-admission-$$-$RANDOM"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/otel-scrape-nix-admission.XXXXXX")"
case "$mode" in
  smoke)
    expected_descriptor_digest=""
    ;;
  admit)
    expected_descriptor_digest="${BUCK2_OTEL_EXPECTED_DESCRIPTOR_DIGEST:?admission requires externally supplied BUCK2_OTEL_EXPECTED_DESCRIPTOR_DIGEST}"
    ;;
  *)
    echo "buck2:otel-scrape:nix-admission: mode must be smoke or admit" >&2
    exit 64
    ;;
esac
cleanup() {
  "$buck2_bin" --isolation-dir "$isolation" kill >/dev/null 2>&1 || true
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT

buck_output="$($buck2_bin \
  --isolation-dir "$isolation" \
  build \
  --config-file "$toolchain_config" \
  --target-platforms //buck2/platforms:target_x86_64_linux_musl_static \
  //packages/@overeng/otel-scrape:product \
  '//packages/@overeng/otel-scrape:product[descriptor]' \
  --show-full-output --local-only --no-remote-cache)"
archive="$(printf '%s\n' "$buck_output" | "$awk_bin" \
  '$1 == "root//packages/@overeng/otel-scrape:product" { print $2 }')"
descriptor="$(printf '%s\n' "$buck_output" | "$awk_bin" \
  '$1 == "root//packages/@overeng/otel-scrape:product[descriptor]" { print $2 }')"
[ -f "$archive" ] && [ -f "$descriptor" ] || {
  echo "buck2:otel-scrape:nix-admission: Buck omitted the exact product pair" >&2
  exit 1
}

export BUCK2_OTEL_PRODUCT_ARCHIVE="$archive"
export BUCK2_OTEL_PRODUCT_DESCRIPTOR="$descriptor"
export BUCK2_OTEL_PRODUCT_REPO="$repo_root"
descriptor_digest_expr='let
  repo = builtins.toPath (builtins.getEnv "BUCK2_OTEL_PRODUCT_REPO");
  contract = import (repo + "/nix/workspace-tools/lib/buck2-build-product-contract.nix");
  descriptor = builtins.fromJSON (builtins.readFile (builtins.getEnv "BUCK2_OTEL_PRODUCT_DESCRIPTOR"));
in contract.descriptorDigest descriptor'
if [ "$mode" = smoke ]; then
  expected_descriptor_digest="$($nix_bin eval --impure --raw --expr "$descriptor_digest_expr")"
fi
export BUCK2_OTEL_EXPECTED_DESCRIPTOR_DIGEST="$expected_descriptor_digest"

import_expr='let
  repo = builtins.toPath (builtins.getEnv "BUCK2_OTEL_PRODUCT_REPO");
  pkgs = import (builtins.getFlake (toString repo)).inputs.nixpkgs { system = builtins.currentSystem; };
  importArtifact = import (repo + "/nix/workspace-tools/lib/buck2-artifact-import.nix") { inherit pkgs; };
  descriptor = builtins.fromJSON (builtins.readFile (builtins.getEnv "BUCK2_OTEL_PRODUCT_DESCRIPTOR"));
  artifact = builtins.path { path = builtins.getEnv "BUCK2_OTEL_PRODUCT_ARCHIVE"; name = "otel-scrape-buck-product.tar"; };
in importArtifact {
  inherit artifact descriptor;
  expectedDescriptorDigest = builtins.getEnv "BUCK2_OTEL_EXPECTED_DESCRIPTOR_DIGEST";
  expectedPlatform = { os = "linux"; architecture = "x86_64"; abi = "musl"; };
}'

substituted_descriptor="$fixture_root/descriptor.substituted.json"
"$jq_bin" -c '.semanticProvenance.recipe += "-substituted"' "$descriptor" >"$substituted_descriptor"
export BUCK2_OTEL_PRODUCT_DESCRIPTOR="$substituted_descriptor"
red_log="$fixture_root/substitution-red.log"
if "$nix_bin" build --impure --no-link --expr "$import_expr" >"$red_log" 2>&1; then
  echo "buck2:otel-scrape:nix-admission: substituted descriptor retained admission" >&2
  exit 1
fi
grep -F "descriptor digest mismatch" "$red_log" >/dev/null || {
  echo "buck2:otel-scrape:nix-admission: substitution failed outside descriptor identity seam" >&2
  sed -n '1,120p' "$red_log" >&2
  exit 1
}
echo "buck2:otel-scrape:nix-admission: RED descriptor substitution"

export BUCK2_OTEL_PRODUCT_DESCRIPTOR="$descriptor"
imported="$($nix_bin build --impure --no-link --print-out-paths --expr "$import_expr")"
[ -x "$imported/bin/otel-scrape" ]
"$jq_bin" -e '
  .semanticProvenance.target == "root//packages/@overeng/otel-scrape:product" and
  .runtime == {kind: "self-contained", inspectionContract: "elf-static/v1"}
' "$imported/share/buck-build-product/descriptor.json" >/dev/null
echo "buck2:otel-scrape:nix-admission: GREEN mode=$mode digest=$expected_descriptor_digest"
