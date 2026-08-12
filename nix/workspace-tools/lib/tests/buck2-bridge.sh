#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
export BUCK2_BRIDGE_REPO="$repo_root"

common_let='repo = builtins.toPath (builtins.getEnv "BUCK2_BRIDGE_REPO");
  flake = builtins.getFlake (toString repo);
  pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  test = import (repo + "/nix/workspace-tools/lib/tests/buck2-bridge.nix") { inherit pkgs; };
  contract = import (repo + "/nix/workspace-tools/lib/buck2-build-product-contract.nix");
  mkStrictDescriptor = { original, entrypoints }: {
    schema = "buck-build-product/v1";
    name = "fixture-tool";
    platform = { os = "linux"; architecture = "x86_64"; abi = "musl"; };
    payload = original.artifact;
    inherit entrypoints;
    runtime = { kind = "self-contained"; inspectionContract = "elf-static/v1"; };
    semanticProvenance = {
      target = "//fixtures:tool";
      recipe = "fixture-tool/v1";
      toolchain = "rust-linux-musl/v1";
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

# Close the bridge seam: the exact Nix store artifacts and byte identities are
# configured into Buck, staged by the Nix-realized Rust verifier under hostile
# PATH, then executed as RunInfo by a second Buck action.
buck2_bin="${BUCK2_BIN:?BUCK2_BIN is required for the Nix to Buck bridge proof}"
stage0_config="${BUCK2_STAGE0_CONFIG:?BUCK2_STAGE0_CONFIG is required}"
bridge_config="$(mktemp)"
trap 'rm -f "$bridge_config"' EXIT
cp "$stage0_config" "$bridge_config"
archive_sha256="$(sha256sum "$archive" | awk '{ print $1 }')"
descriptor_sha256="$(sha256sum "$descriptor" | awk '{ print $1 }')"
{
  printf '\n[buck2_bridge]\n'
  printf '  archive = %s\n' "$archive"
  printf '  archive_sha256 = %s\n' "$archive_sha256"
  printf '  descriptor = %s\n' "$descriptor"
  printf '  descriptor_sha256 = %s\n' "$descriptor_sha256"
} >>"$bridge_config"
buck_output="$("$buck2_bin" build --config-file "$bridge_config" \
  //buck2/toolchains:configured_nix_export_evidence \
  --show-full-output --local-only --no-remote-cache)"
buck_evidence="$(printf '%s\n' "$buck_output" | awk \
  '$1 == "root//buck2/toolchains:configured_nix_export_evidence" { print $2 }')"
[ -f "$buck_evidence" ] || {
  echo "buck2-bridge-test: Buck did not materialize configured Nix export evidence" >&2
  exit 1
}
grep -Fx 'portable-toolchain-ok' "$buck_evidence" >/dev/null || {
  echo "buck2-bridge-test: configured Nix export did not execute through Buck RunInfo" >&2
  exit 1
}

export BUCK2_BRIDGE_EXPORT_OUT="$export_out"
unsupported_runtime_expr="let
  $common_let
  exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_EXPORT_OUT\");
    original = builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\"));
    descriptor = mkStrictDescriptor {
      inherit original;
      entrypoints = [ \"bin/fixture-tool\" ];
    };
  in test.mkImport {
    inherit descriptor;
    expectedDescriptorDigest = contract.descriptorDigest descriptor;
    expectedPlatform = descriptor.platform;
    artifact = exported + \"/artifact.tar\";
  }"
expect_build_failure \
  "unsupported build-product runtime" \
  "runtime inspector is not available for self-contained" \
  "$unsupported_runtime_expr"

duplicate_import_entrypoint_expr="let
  $common_let
  exported = builtins.storePath (builtins.getEnv \"BUCK2_BRIDGE_EXPORT_OUT\");
    original = builtins.fromJSON (builtins.readFile (exported + \"/descriptor.json\"));
    descriptor = mkStrictDescriptor {
      inherit original;
      entrypoints = [ \"bin/fixture-tool\" \"bin/fixture-tool\" ];
    };
  in test.mkImport {
    inherit descriptor;
    expectedDescriptorDigest = \"sha256:0000000000000000000000000000000000000000000000000000000000000000\";
    expectedPlatform = descriptor.platform;
    artifact = exported + \"/artifact.tar\";
  }"
expect_build_failure \
  "duplicate import entrypoint" \
  "descriptor.entrypoints entries must be unique" \
  "$duplicate_import_entrypoint_expr"

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

expect_build_failure \
  "control-character entrypoint export" \
  "entrypoints must be safe relative paths" \
  "($base_expr).controlCharacterEntrypointExport"

expect_build_failure \
  "duplicate entrypoint export" \
  "entrypoints must be unique" \
  "($base_expr).duplicateEntrypointExport"

scan_expr="let
  $common_let
in import (repo + \"/nix/workspace-tools/lib/buck2-artifact-scan.nix\") { inherit pkgs; }"
scan_out="$(build_expr "$scan_expr")"

portable_symlink_root="$(mktemp -d)"
mkdir -p "$portable_symlink_root/bin" "$portable_symlink_root/lib"
printf '%s\n' portable >"$portable_symlink_root/lib/tool"
ln -s ../lib/tool "$portable_symlink_root/bin/tool"
"$scan_out" tree "$portable_symlink_root"
rm -rf "$portable_symlink_root"

for symlink_case in \
  'backslash|foo\bar|portable POSIX separators' \
  'repeated-separator|foo//bar|normalized' \
  'dot-component|foo/./bar|normalized'
do
  symlink_label="${symlink_case%%|*}"
  symlink_remainder="${symlink_case#*|}"
  symlink_target="${symlink_remainder%%|*}"
  symlink_diagnostic="${symlink_remainder#*|}"
  symlink_root="$(mktemp -d)"
  ln -s "$symlink_target" "$symlink_root/link"
  expect_command_failure \
    "$symlink_label symlink target" \
    "$symlink_diagnostic" \
    "$scan_out" tree "$symlink_root"
  rm -rf "$symlink_root"
done

control_symlink_targets=($'foo\nbar' $'foo\tbar' $'foo\x7fbar')
for control_index in "${!control_symlink_targets[@]}"; do
  control_symlink_root="$(mktemp -d)"
  ln -s "${control_symlink_targets[$control_index]}" "$control_symlink_root/link"
  expect_command_failure \
    "control-character-$control_index symlink target" \
    "control characters" \
    "$scan_out" tree "$control_symlink_root"
  rm -rf "$control_symlink_root"
done

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

trailing_root="$(mktemp -d)"
printf '%s\n' payload >"$trailing_root/file"
tar --create --file "$trailing_root.tar" --directory "$trailing_root" file
printf '%s' trailing-bytes >>"$trailing_root.tar"
expect_command_failure \
  "trailing archive bytes" \
  "archive contains trailing data after end-of-archive marker" \
  "$scan_out" archive "$trailing_root.tar"
rm -rf "$trailing_root" "$trailing_root.tar"

concatenated_root="$(mktemp -d)"
printf '%s\n' first >"$concatenated_root/first"
printf '%s\n' second >"$concatenated_root/second"
tar --create --file "$concatenated_root.tar" --directory "$concatenated_root" first
tar --create --file "$concatenated_root-second.tar" --directory "$concatenated_root" second
${CAT_BIN:-cat} "$concatenated_root-second.tar" >>"$concatenated_root.tar"
expect_command_failure \
  "concatenated archive" \
  "archive contains trailing data after end-of-archive marker" \
  "$scan_out" archive "$concatenated_root.tar"
rm -rf "$concatenated_root" "$concatenated_root.tar" "$concatenated_root-second.tar"

echo "buck2-bridge-test: PASS export=$export_out buck_runinfo=executed importer=fail-closed"
