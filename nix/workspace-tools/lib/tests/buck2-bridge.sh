#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
export BUCK2_BRIDGE_REPO="$repo_root"

common_let='repo = builtins.toPath (builtins.getEnv "BUCK2_BRIDGE_REPO");
  flake = builtins.getFlake (toString repo);
  pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  test = import (repo + "/nix/workspace-tools/lib/tests/buck2-bridge.nix") { inherit pkgs; };
  asBuckDescriptor = original: (builtins.removeAttrs original [ "normalization" ]) // {
    kind = "buck2-build-artifact";
    provenance = {
      producer = "buck2-test-fixture";
      target = "//fixtures:portable-tool";
      sourceRevision = "0123456789abcdef0123456789abcdef01234567";
      actionDigest = original.artifact.digest.sri;
    };
  };'
base_expr="let
  $common_let
in test"

build_expr() {
  nix build --impure --no-link --print-out-paths --expr "$1"
}

expect_build_failure() {
  local label="$1"
  local expected="$2"
  local expression="$3"
  local log
  log="$(mktemp)"
  if nix build --impure --no-link --expr "$expression" >"$log" 2>&1; then
    echo "buck2-bridge-test: expected $label to fail" >&2
    rm -f "$log"
    exit 1
  fi
  if ! grep -F "$expected" "$log" >/dev/null; then
    echo "buck2-bridge-test: $label failed without expected diagnostic: $expected" >&2
    sed -n '1,160p' "$log" >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
  echo "buck2-bridge-test: RED $label"
}

expect_command_failure() {
  local label="$1"
  local expected="$2"
  shift 2
  local log
  log="$(mktemp)"
  if "$@" >"$log" 2>&1; then
    echo "buck2-bridge-test: expected $label to fail" >&2
    rm -f "$log"
    exit 1
  fi
  if ! grep -F "$expected" "$log" >/dev/null; then
    echo "buck2-bridge-test: $label failed without expected diagnostic: $expected" >&2
    sed -n '1,160p' "$log" >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
  echo "buck2-bridge-test: RED $label"
}

export_out="$(build_expr "($base_expr).portableExport")"
descriptor="$export_out/descriptor.json"
archive="$export_out/artifact.tar"

jq -e '
  .schemaVersion == 1 and
  .kind == "buck2-portable-toolchain-artifact" and
  .name == "fixture-tool" and
  .artifact.format == "tar" and
  .artifact.digest.algorithm == "sha256" and
  .entrypoints == ["bin/fixture-tool"] and
  .provenance.producer == "effect-utils.buck2-toolchain-export"
' "$descriptor" >/dev/null

declared_digest="$(jq -r '.artifact.digest.sri' "$descriptor")"
actual_digest="$(nix hash file --type sha256 --sri "$archive")"
[ "$declared_digest" = "$actual_digest" ]

export BUCK2_BRIDGE_EXPORT_OUT="$export_out"
import_expr="let
  $common_let
  exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_EXPORT_OUT\");
    descriptor = asBuckDescriptor (builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\")));
  in test.mkImport {
    inherit descriptor;
    artifact = exported + \"/artifact.tar\";
  }"
import_out="$(build_expr "$import_expr")"

[ "$(env -i PATH=/nonexistent "$import_out/bin/fixture-tool")" = "buck2-bridge-ok" ]
[ -f "$import_out/share/buck2-artifact/descriptor.json" ]
jq -e '
  .kind == "buck2-build-artifact" and
  .provenance.target == "//fixtures:portable-tool"
' "$import_out/share/buck2-artifact/descriptor.json" >/dev/null
if grep -a -R -F '/nix/store/' "$import_out" >/dev/null; then
  echo "buck2-bridge-test: imported artifact contains a Nix store reference" >&2
  exit 1
fi
[ -z "$(nix-store --query --references "$import_out")" ]

expect_build_failure \
  "store-reference export" \
  "forbidden Nix store reference" \
  "($base_expr).storeReferenceExport"

expect_build_failure \
  "escaping-symlink export" \
  "symlink escapes artifact root" \
  "($base_expr).escapingSymlinkExport"

expect_build_failure \
  "non-canonical entrypoint export" \
  "entrypoints must be safe relative paths" \
  "($base_expr).nonCanonicalEntrypointExport"

expect_build_failure \
  "repeated-separator entrypoint export" \
  "entrypoints must be safe relative paths" \
  "($base_expr).repeatedSeparatorEntrypointExport"

expect_build_failure \
  "backslash entrypoint export" \
  "entrypoints must be safe relative paths" \
  "($base_expr).backslashEntrypointExport"

wrong_digest_expr="let
  $common_let
  exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_EXPORT_OUT\");
    original = asBuckDescriptor (builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\")));
    descriptor = original // {
      artifact = original.artifact // {
        digest = original.artifact.digest // {
          sri = \"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\";
        };
      };
    };
  in test.mkImport {
    inherit descriptor;
    artifact = exported + \"/artifact.tar\";
  }"
expect_build_failure "wrong digest import" "hash mismatch" "$wrong_digest_expr"

wrong_size_expr="let
  $common_let
  exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_EXPORT_OUT\");
    original = asBuckDescriptor (builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\")));
    descriptor = original // {
      artifact = original.artifact // { sizeBytes = original.artifact.sizeBytes + 1; };
    };
  in test.mkImport {
    inherit descriptor;
    artifact = exported + \"/artifact.tar\";
  }"
expect_build_failure "wrong size import" "size mismatch" "$wrong_size_expr"

unknown_descriptor_field_expr="let
  $common_let
  exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_EXPORT_OUT\");
  descriptor = (asBuckDescriptor (builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\"))) // {
    unexpected = true;
  });
  in test.mkImport {
    inherit descriptor;
    artifact = exported + \"/artifact.tar\";
  }"
expect_build_failure \
  "unknown descriptor field" \
  "descriptor contains unknown fields" \
  "$unknown_descriptor_field_expr"

reserved_metadata_out="$(build_expr "($base_expr).reservedMetadataExport")"
export BUCK2_BRIDGE_RESERVED_METADATA_OUT="$reserved_metadata_out"
reserved_metadata_expr="let
  $common_let
  exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_RESERVED_METADATA_OUT\");
  descriptor = asBuckDescriptor (builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\")));
  in test.mkImport {
    inherit descriptor;
    artifact = exported + \"/artifact.tar\";
  }"
expect_build_failure \
  "reserved importer metadata path" \
  "artifact occupies reserved importer metadata path" \
  "$reserved_metadata_expr"

for entrypoint_case in \
  "repeated-separator|bin//fixture-tool" \
  "dot-component|bin/./fixture-tool" \
  'backslash|bin\fixture-tool'
do
  entrypoint_label="${entrypoint_case%%|*}"
  entrypoint_value="${entrypoint_case#*|}"
  export BUCK2_BRIDGE_ENTRYPOINT="$entrypoint_value"
  non_canonical_import_entrypoint_expr="let
    $common_let
    exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_EXPORT_OUT\");
    original = asBuckDescriptor (builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\")));
    descriptor = original // { entrypoints = [ (builtins.getEnv \"BUCK2_BRIDGE_ENTRYPOINT\") ]; };
    in test.mkImport {
      inherit descriptor;
      artifact = exported + \"/artifact.tar\";
    }"
  expect_build_failure \
    "$entrypoint_label import entrypoint" \
    "descriptor entrypoints must be canonical safe relative paths" \
    "$non_canonical_import_entrypoint_expr"
done

wrong_platform_expr="let
  $common_let
  exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_EXPORT_OUT\");
    original = asBuckDescriptor (builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\")));
    descriptor = original // { platform = \"definitely-not-${system:-current}-platform\"; };
  in test.mkImport {
    inherit descriptor;
    artifact = exported + \"/artifact.tar\";
  }"
expect_build_failure "wrong platform import" "platform mismatch" "$wrong_platform_expr"

scan_expr="let
  $common_let
in import (repo + \"/nix/workspace-tools/lib/buck2-artifact-scan.nix\") { inherit pkgs; }"
scan_out="$(build_expr "$scan_expr")"
special_root="$(mktemp -d)"
trap 'rm -rf "$special_root"' EXIT
mkfifo "$special_root/fixture.fifo"
expect_command_failure \
  "special tree node" \
  "unsupported tree node type" \
  "$scan_out" tree "$special_root"
tar --create --file "$special_root.tar" --directory "$special_root" .
expect_command_failure \
  "special archive member" \
  "unsupported archive member type" \
  "$scan_out" archive "$special_root.tar"
rm -f "$special_root.tar"

duplicate_root="$(mktemp -d)"
mkdir -p "$duplicate_root/bin"
printf '%s\n' first >"$duplicate_root/bin/tool"
tar --create --file "$duplicate_root.tar" --directory "$duplicate_root" bin/tool
printf '%s\n' second >"$duplicate_root/bin/tool"
tar --append --file "$duplicate_root.tar" --directory "$duplicate_root" bin/tool
expect_command_failure \
  "duplicate archive member" \
  "duplicate archive member: bin/tool" \
  "$scan_out" archive "$duplicate_root.tar"
rm -rf "$duplicate_root" "$duplicate_root.tar"

trailing_root="$(mktemp -d)"
printf '%s\n' canonical >"$trailing_root/file"
tar --create --file "$trailing_root.tar" --directory "$trailing_root" file
printf 'x' >>"$trailing_root.tar"
dd if=/dev/zero bs=511 count=1 status=none >>"$trailing_root.tar"
expect_command_failure \
  "non-zero bytes after archive end marker" \
  "non-zero data after archive end marker" \
  "$scan_out" archive "$trailing_root.tar"
rm -rf "$trailing_root" "$trailing_root.tar"

backslash_root="$(mktemp -d)"
mkdir -p "$backslash_root/share"
tar --create --file "$backslash_root.tar" --directory "$backslash_root" \
  --transform='s|share|share\\bad|' share
expect_command_failure \
  "backslash archive member" \
  "archive member must use portable POSIX separators" \
  "$scan_out" archive "$backslash_root.tar"
rm -rf "$backslash_root" "$backslash_root.tar"

collision_root="$(mktemp -d)"
mkdir -p "$collision_root/inside"
printf '%s\n' collision >"$collision_root/inside/file"
ln -s inside "$collision_root/link"
tar --create --file "$collision_root.tar" --directory "$collision_root" link
tar --append --file "$collision_root.tar" --directory "$collision_root" \
  --transform='s|inside|link|' inside/file
expect_command_failure \
  "symlink ancestor archive member" \
  "archive member is beneath symlink ancestor" \
  "$scan_out" archive "$collision_root.tar"
rm -rf "$collision_root" "$collision_root.tar"

sparse_root="$(mktemp -d)"
truncate --size=5G "$sparse_root/oversized"
tar --sparse --create --file "$sparse_root.tar" --directory "$sparse_root" oversized
expect_command_failure \
  "oversized sparse archive member" \
  "archive member exceeds extracted-size limit" \
  "$scan_out" archive "$sparse_root.tar"
rm -rf "$sparse_root" "$sparse_root.tar"

aggregate_root="$(mktemp -d)"
for index in 1 2 3 4 5; do
  truncate --size=900M "$aggregate_root/part-$index"
done
tar --sparse --create --file "$aggregate_root.tar" --directory "$aggregate_root" .
expect_command_failure \
  "aggregate sparse archive size" \
  "archive exceeds aggregate extracted-size limit" \
  "$scan_out" archive "$aggregate_root.tar"
rm -rf "$aggregate_root" "$aggregate_root.tar"

echo "buck2-bridge-test: PASS export=$export_out import=$import_out"
