#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
workspace_manifest="$repo_root/rust/Cargo.toml"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/effect-utils-rust-workspace-contract.XXXXXX")"
trap 'rm -rf -- "$fixture_root"' EXIT

fail() {
  echo "rust-workspace-contract: $*" >&2
  exit 1
}

expect_failure() {
  local label="$1"
  local expected_pattern="$2"
  shift 2
  local log="$fixture_root/$label.log"

  if "$@" >"$log" 2>&1; then
    fail "expected $label to fail"
  fi
  if ! grep -E "$expected_pattern" "$log" >/dev/null; then
    sed -n '1,120p' "$log" >&2
    fail "$label failed without expected diagnostic: $expected_pattern"
  fi
  echo "rust-workspace-contract: RED $label"
}

metadata="$fixture_root/workspace-metadata.json"
cargo metadata \
  --manifest-path "$workspace_manifest" \
  --locked \
  --no-deps \
  --format-version 1 >"$metadata"

expected_packages='["buck2-archive-tool","buck2-product","buck2-tool-core","otel-scrape","otelite"]'
jq -e --argjson expected "$expected_packages" '
  (.packages | map(.name) | sort) == $expected and
  all(.packages[]; .version == "0.0.0" and .edition == "2021" and .license == "MIT") and
  ([.packages[] | select(.name == "otel-scrape") | .dependencies[] |
      select(.name == "libc") | {req, target}] == [{req: "=0.2.186", target: null}]) and
  ([.packages[] | select(.name == "otelite") | .dependencies[] |
      select(.name == "libc") | {req, target}] == [{req: "^0.2.186", target: "cfg(unix)"}])
' "$metadata" >/dev/null || fail "metadata did not preserve inherited fields and local libc exceptions"

mapfile -t workspace_members < <(jq -r '.workspace_members[]' "$metadata" | sort)
[ "${#workspace_members[@]}" -eq "$(jq 'length' <<<"$expected_packages")" ] ||
  fail "workspace metadata omitted a declared member"

# Decision 0024 admission correspondence: every Cargo workspace member must
# project exactly one Buck package, and only the two application members may
# emit BuildProducts (the three support crates are toolchain surface, not
# products). The projection generator fails loudly on member drift at
# genie:run time; these assertions keep the cargo:check lane proving that
# admission still matches the workspace.
while IFS= read -r manifest; do
  member_dir="$(dirname "$manifest")"
  case "$member_dir" in
    "$repo_root"/*) ;;
    *) fail "workspace member is outside the repository: $manifest" ;;
  esac
  [ -f "$member_dir/BUCK.genie.ts" ] || fail "workspace member has no Buck projection: $manifest"
  [ -f "$member_dir/BUCK" ] || fail "workspace member has no generated Buck package: $manifest"
  echo "rust-workspace-contract: GREEN buck admission for ${member_dir#"$repo_root"/}"
done < <(jq -r '.packages[].manifest_path' "$metadata")

for product_member in packages/@overeng/otelite packages/@overeng/otel-scrape; do
  product_name="$(basename "$product_member")-product"
  grep -Fq "name = \"$product_name\"" "$repo_root/$product_member/BUCK" ||
    fail "$product_member/BUCK does not emit its BuildProduct target $product_name"
  echo "rust-workspace-contract: GREEN $product_member emits $product_name"
done
for tool_member in rust/buck2-tools/archive-tool rust/buck2-tools/core rust/buck2-tools/product; do
  if grep -Fq 'build_product(' "$repo_root/$tool_member/BUCK"; then
    fail "$tool_member/BUCK must not emit a BuildProduct target"
  fi
  echo "rust-workspace-contract: GREEN $tool_member stays product-free"
done

mkdir -p "$fixture_root/inheritance/packages/@overeng/otel-scrape/src"
mkdir -p "$fixture_root/inheritance/rust"
cp "$workspace_manifest" "$fixture_root/inheritance/rust/Cargo.toml"
cp "$repo_root/packages/@overeng/otel-scrape/Cargo.toml" \
  "$fixture_root/inheritance/packages/@overeng/otel-scrape/Cargo.toml"
cp "$repo_root/packages/@overeng/otel-scrape/src/lib.rs" \
  "$fixture_root/inheritance/packages/@overeng/otel-scrape/src/lib.rs"
inheritance_manifest="$fixture_root/inheritance/packages/@overeng/otel-scrape/Cargo.toml"
inheritance_manifest_rewritten="$fixture_root/inheritance/Cargo.toml.rewritten"
grep -v '^workspace = ' "$inheritance_manifest" >"$inheritance_manifest_rewritten"
mv "$inheritance_manifest_rewritten" "$inheritance_manifest"
expect_failure \
  "missing-explicit-workspace-link" \
  "failed to find a workspace root|workspace[.]dependencies.*was not defined" \
  cargo metadata \
  --manifest-path "$fixture_root/inheritance/packages/@overeng/otel-scrape/Cargo.toml" \
  --offline \
  --no-deps \
  --format-version 1

mkdir -p "$fixture_root/member-only/packages/@overeng/otel-scrape/src"
cp "$repo_root/packages/@overeng/otel-scrape/Cargo.toml" \
  "$fixture_root/member-only/packages/@overeng/otel-scrape/Cargo.toml"
cp "$repo_root/packages/@overeng/otel-scrape/src/lib.rs" \
  "$fixture_root/member-only/packages/@overeng/otel-scrape/src/lib.rs"
expect_failure \
  "member-only-source" \
  "/rust/Cargo[.]toml" \
  cargo metadata \
  --manifest-path "$fixture_root/member-only/packages/@overeng/otel-scrape/Cargo.toml" \
  --offline \
  --no-deps \
  --format-version 1


[ -f "$repo_root/rust-toolchain.toml" ] || fail "repository rust-toolchain.toml is missing"
[ ! -e "$repo_root/packages/@overeng/otel-scrape/rust-toolchain.toml" ] ||
  fail "otel-scrape shadows the repository toolchain"
[ ! -e "$repo_root/packages/@overeng/otelite/rust-toolchain.toml" ] ||
  fail "otelite shadows the repository toolchain"

echo "rust-workspace-contract: PASS"
