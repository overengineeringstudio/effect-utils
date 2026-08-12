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
  local expected="$2"
  shift 2
  local log="$fixture_root/$label.log"

  if "$@" >"$log" 2>&1; then
    fail "expected $label to fail"
  fi
  if ! grep -F "$expected" "$log" >/dev/null; then
    sed -n '1,120p' "$log" >&2
    fail "$label failed without expected diagnostic: $expected"
  fi
  echo "rust-workspace-contract: RED $label"
}

metadata="$fixture_root/workspace-metadata.json"
cargo metadata \
  --manifest-path "$workspace_manifest" \
  --locked \
  --no-deps \
  --format-version 1 >"$metadata"

jq -e '
  (.packages | map(.name) | sort) == ["otel-scrape", "otelite"] and
  all(.packages[]; .version == "0.0.0" and .edition == "2021" and .license == "MIT") and
  ([.packages[] | select(.name == "otel-scrape") | .dependencies[] |
      select(.name == "libc") | {req, target}] == [{req: "=0.2.186", target: null}]) and
  ([.packages[] | select(.name == "otelite") | .dependencies[] |
      select(.name == "libc") | {req, target}] == [{req: "^0.2.186", target: "cfg(unix)"}])
' "$metadata" >/dev/null || fail "metadata did not preserve inherited fields and local libc exceptions"

mapfile -t workspace_members < <(jq -r '.workspace_members[]' "$metadata" | sort)
[ "${#workspace_members[@]}" -eq 2 ] || fail "workspace must have exactly two members"

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
  "failed to find a workspace root" \
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
  "/rust/Cargo.toml" \
  cargo metadata \
  --manifest-path "$fixture_root/member-only/packages/@overeng/otel-scrape/Cargo.toml" \
  --offline \
  --no-deps \
  --format-version 1

export EFFECT_UTILS_RUST_WORKSPACE_REPO="$repo_root"
# `${...}` below is Nix attribute interpolation, not shell expansion.
# shellcheck disable=SC2016
source_expr='let
  repo = builtins.toPath (builtins.getEnv "EFFECT_UTILS_RUST_WORKSPACE_REPO");
  flake = builtins.getFlake (toString repo);
in {
  otelScrape = toString flake.packages.${builtins.currentSystem}.otel-scrape.src;
  otelite = toString flake.packages.${builtins.currentSystem}.otelite.src;
}'
source_json="$(nix eval --impure --json --expr "$source_expr")"

check_source() {
  local package="$1"
  local sibling="$2"
  local source_path="$3"

  [ -f "$source_path/rust/Cargo.toml" ] || fail "$package source omitted rust/Cargo.toml"
  [ -f "$source_path/rust/Cargo.lock" ] || fail "$package source omitted rust/Cargo.lock"
  [ -f "$source_path/rust-toolchain.toml" ] || fail "$package source omitted root rust-toolchain.toml"
  [ -f "$source_path/packages/@overeng/otel-scrape/Cargo.toml" ] ||
    fail "$package source omitted otel-scrape member manifest"
  [ -f "$source_path/packages/@overeng/otelite/Cargo.toml" ] ||
    fail "$package source omitted otelite member manifest"
  [ -f "$source_path/packages/@overeng/$package/src/lib.rs" ] ||
    fail "$package source omitted selected member source"
  [ ! -e "$source_path/packages/@overeng/$sibling/src/lib.rs" ] ||
    fail "$package source captured sibling source"
  [ ! -e "$source_path/package.json" ] || fail "$package source captured unrelated repository files"

  cargo metadata \
    --manifest-path "$source_path/rust/Cargo.toml" \
    --locked \
    --no-deps \
    --format-version 1 >/dev/null
  echo "rust-workspace-contract: GREEN $package workspace-aware narrow source"
}

check_source "otel-scrape" "otelite" "$(jq -r '.otelScrape' <<<"$source_json")"
check_source "otelite" "otel-scrape" "$(jq -r '.otelite' <<<"$source_json")"

[ -f "$repo_root/rust-toolchain.toml" ] || fail "repository rust-toolchain.toml is missing"
[ ! -e "$repo_root/packages/@overeng/otel-scrape/rust-toolchain.toml" ] ||
  fail "otel-scrape shadows the repository toolchain"
[ ! -e "$repo_root/packages/@overeng/otelite/rust-toolchain.toml" ] ||
  fail "otelite shadows the repository toolchain"

echo "rust-workspace-contract: PASS"
