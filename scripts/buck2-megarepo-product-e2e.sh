#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-megarepo-product-e2e.sh REPO_ROOT BUCK2_BIN TARGET [BUCK_ARGS...]}"
buck2_bin="${2:?buck2 binary is required}"
target="${3:?target is required}"
shift 3
quality_target="${target%:*}:mr_quality"
awk_bin="${AWK_BIN:?AWK_BIN is required}"
cp_bin="${CP_BIN:?CP_BIN is required}"
dd_bin="${DD_BIN:?DD_BIN is required}"
grep_bin="${GREP_BIN:?GREP_BIN is required}"
jq_bin="${JQ_BIN:?JQ_BIN is required}"
mktemp_bin="${MKTEMP_BIN:?MKTEMP_BIN is required}"
nix_bin="${NIX_BIN:?NIX_BIN is required}"
rm_bin="${RM_BIN:?RM_BIN is required}"
bun_bin="${BUN_BIN:?BUN_BIN is required}"
tar_bin="${TAR_BIN:?TAR_BIN is required}"
wc_bin="${WC_BIN:?WC_BIN is required}"
chmod_bin="${CHMOD_BIN:?CHMOD_BIN is required}"
included_non_src="$repo_root/packages/@overeng/tui-react/test/unit/tree.test.tsx"
red_log="$($mktemp_bin)"
source_backup="$($mktemp_bin)"
tampered_artifact="$($mktemp_bin)"
evidence_dir="$($mktemp_bin -d)"
event_log="$evidence_dir/event-log.jsonl"
build_report="$evidence_dir/build-report.json"
machine_dir="$($mktemp_bin -d)"
machine_artifact="$($mktemp_bin)"
source_mutated=0
cleanup() {
  if [ "$source_mutated" = 1 ]; then "$cp_bin" --preserve=mode,timestamps "$source_backup" "$included_non_src"; fi
  "$rm_bin" -rf "$red_log" "$source_backup" "$tampered_artifact" "$evidence_dir" "$machine_dir" "$machine_artifact"
}
trap cleanup EXIT
evidence_start_us="${EPOCHREALTIME/./}"
output="$("$buck2_bin" build "$target" "$target[descriptor]" "$quality_target" "$@" --show-full-output --local-only --no-remote-cache --event-log "$event_log" --build-report "$build_report")"
evidence_duration_ms=$(( (${EPOCHREALTIME/./} - evidence_start_us) / 1000 ))
artifact="$(printf '%s\n' "$output" | "$awk_bin" -v label="root${target}" '$1 == label { print $2 }')"
descriptor="$(printf '%s\n' "$output" | "$awk_bin" -v label="root${target}[descriptor]" '$1 == label { print $2 }')"
[ -f "$artifact" ] && [ -f "$descriptor" ] || { echo "megarepo product outputs are missing" >&2; exit 1; }
echo "buck2-megarepo-product-e2e: QUALITY PASS target=$quality_target"
"$bun_bin" "$repo_root/packages/@overeng/buck2-tools/src/evidence/cli.ts" \
  --event-log "$event_log" \
  --build-report "$build_report" \
  --duration-ms "$evidence_duration_ms" \
  --workspace-root "$repo_root"
echo "buck2-megarepo-product-e2e: EVIDENCE PASS verdict=PASS negative=NO_VERDICT(malformed-event-log)"

source_mutated=1
printf '\nconst buck2IncludedNonSrcRed: never = 1\n' >>"$included_non_src"
: >"$red_log"
if "$buck2_bin" build "$quality_target" "$@" --local-only --no-remote-cache >"$red_log" 2>&1; then
  echo "mr_quality accepted an invalid included non-src project file" >&2
  exit 1
fi
"$grep_bin" -E "TS2322|not assignable" "$red_log" >/dev/null || { echo "included non-src RED missed its asserted typecheck seam" >&2; exit 1; }
"$cp_bin" --preserve=mode,timestamps "$source_backup" "$included_non_src"
source_mutated=0
"$buck2_bin" build "$quality_target" "$@" --local-only --no-remote-cache >/dev/null
echo "buck2-megarepo-product-e2e: INCLUDED NON-SRC RED/GREEN PASS path=packages/@overeng/tui-react/test/unit/tree.test.tsx"

export BUCK2_PRODUCT_DESCRIPTOR="$descriptor"
export BUCK2_PRODUCT_CONTRACT="$repo_root/nix/workspace-tools/lib/buck2-build-product-contract.nix"
canonical="$($nix_bin eval --impure --raw --expr '
  let contract = import (builtins.toPath (builtins.getEnv "BUCK2_PRODUCT_CONTRACT"));
      descriptor = builtins.fromJSON (builtins.readFile (builtins.getEnv "BUCK2_PRODUCT_DESCRIPTOR"));
  in contract.canonicalDescriptorJson descriptor
')"
[ "$canonical" = "$($jq_bin -c -S . "$descriptor")" ] || { echo "emitter descriptor is not canonical under the Nix contract" >&2; exit 1; }
if "$nix_bin" eval --impure --raw --expr '
  let contract = import (builtins.toPath (builtins.getEnv "BUCK2_PRODUCT_CONTRACT"));
      descriptor = builtins.fromJSON (builtins.readFile (builtins.getEnv "BUCK2_PRODUCT_DESCRIPTOR"));
  in contract.canonicalDescriptorJson (descriptor // { unknownEmitterField = true; })
' >/dev/null 2>&1; then
  echo "Nix contract accepted an unknown emitter field" >&2
  exit 1
fi

echo "buck2-megarepo-product-e2e: CONTRACT PASS artifact=$artifact descriptor=$descriptor"
export BUCK2_PRODUCT_ARTIFACT_STORE="$($nix_bin store add --mode flat --name artifact.tar "$artifact")"
export BUCK2_PRODUCT_DESCRIPTOR_STORE="$($nix_bin store add --mode flat --name descriptor.json "$descriptor")"
export BUCK2_PRODUCT_IMPORTER="$repo_root/nix/workspace-tools/lib/buck2-artifact-import.nix"
export BUCK2_PRODUCT_NIXPKGS="${BUCK2_PRODUCT_NIXPKGS:?BUCK2_PRODUCT_NIXPKGS must name the pinned nixpkgs store path}"
if "$nix_bin" build --impure --no-link --expr '
  let
    pkgs = import (builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_NIXPKGS")) { system = builtins.currentSystem; };
    contract = import (builtins.toPath (builtins.getEnv "BUCK2_PRODUCT_CONTRACT"));
    importArtifact = import (builtins.toPath (builtins.getEnv "BUCK2_PRODUCT_IMPORTER")) { inherit pkgs; };
    descriptor = builtins.fromJSON (builtins.readFile (builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_DESCRIPTOR_STORE")));
  in importArtifact {
    inherit descriptor;
    expectedDescriptorDigest = contract.descriptorDigest descriptor;
    expectedPlatform = descriptor.platform // { architecture = "intentional-red"; };
    artifact = builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_ARTIFACT_STORE");
  }
' >/dev/null 2>"$red_log"; then
  echo "importer accepted an independently mismatched platform" >&2
  exit 1
fi
"$grep_bin" -F "platform mismatch" "$red_log" >/dev/null || { echo "platform RED missed its asserted seam" >&2; exit 1; }
echo "buck2-megarepo-product-e2e: PLATFORM RED PASS"

"$cp_bin" "$artifact" "$tampered_artifact"
printf '\377' | "$dd_bin" of="$tampered_artifact" bs=1 seek=0 conv=notrunc status=none
export BUCK2_PRODUCT_TAMPERED_ARTIFACT_STORE="$($nix_bin store add --mode flat --name tampered-artifact.tar "$tampered_artifact")"
: >"$red_log"
if "$nix_bin" build --impure --no-link --expr '
  let
    pkgs = import (builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_NIXPKGS")) { system = builtins.currentSystem; };
    contract = import (builtins.toPath (builtins.getEnv "BUCK2_PRODUCT_CONTRACT"));
    importArtifact = import (builtins.toPath (builtins.getEnv "BUCK2_PRODUCT_IMPORTER")) { inherit pkgs; };
    descriptor = builtins.fromJSON (builtins.readFile (builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_DESCRIPTOR_STORE")));
  in importArtifact {
    inherit descriptor;
    expectedDescriptorDigest = contract.descriptorDigest descriptor;
    expectedPlatform = { os = "linux"; architecture = "x86_64"; abi = "glibc"; };
    artifact = builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_TAMPERED_ARTIFACT_STORE");
  }
' >/dev/null 2>"$red_log"; then
  echo "importer accepted a tampered payload" >&2
  exit 1
fi
"$grep_bin" -F "payload digest mismatch" "$red_log" >/dev/null || { echo "payload RED missed its asserted seam" >&2; exit 1; }
echo "buck2-megarepo-product-e2e: PAYLOAD RED PASS"

: >"$red_log"
if "$nix_bin" build --impure --no-link --expr '
  let
    pkgs = import (builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_NIXPKGS")) { system = builtins.currentSystem; };
    contract = import (builtins.toPath (builtins.getEnv "BUCK2_PRODUCT_CONTRACT"));
    importArtifact = import (builtins.toPath (builtins.getEnv "BUCK2_PRODUCT_IMPORTER")) { inherit pkgs; };
    original = builtins.fromJSON (builtins.readFile (builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_DESCRIPTOR_STORE")));
    descriptor = original // { runtime = original.runtime // { machine = "intentional-red"; }; };
  in importArtifact {
    inherit descriptor;
    expectedDescriptorDigest = contract.descriptorDigest descriptor;
    expectedPlatform = { os = "linux"; architecture = "x86_64"; abi = "glibc"; };
    artifact = builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_ARTIFACT_STORE");
  }
' >/dev/null 2>"$red_log"; then
  echo "importer accepted mismatched observed runtime facts" >&2
  exit 1
fi
"$grep_bin" -F "descriptor.runtime.machine must match" "$red_log" >/dev/null || { echo "runtime RED missed its asserted seam" >&2; exit 1; }
echo "buck2-megarepo-product-e2e: RUNTIME RED PASS"

# ELF MACHINE RED: the descriptor claim stays internally consistent (contract
# validation passes) while the payload's real ELF machine field contradicts it
# — readelf observation vs claim must be caught by the inspector seam.
"$tar_bin" -xf "$artifact" -C "$machine_dir"
"$chmod_bin" -R u+w "$machine_dir"
machine_entrypoint="$($jq_bin -r '.entrypoints[0]' "$descriptor")"
case "$($jq_bin -r '.platform.architecture' "$descriptor")" in
  x86_64) foreign_machine='\xb7' ;;
  aarch64) foreign_machine='\x3e' ;;
  *)
    echo "buck2-megarepo-product-e2e: unsupported native ELF architecture" >&2
    exit 1
    ;;
esac
printf '%b' "$foreign_machine" | "$dd_bin" of="$machine_dir/$machine_entrypoint" bs=1 seek=18 conv=notrunc status=none
"$tar_bin" -cf "$machine_artifact" -C "$machine_dir" .
export BUCK2_PRODUCT_MACHINE_ARTIFACT_STORE="$($nix_bin store add --mode flat --name machine-artifact.tar "$machine_artifact")"
export BUCK2_MACHINE_MUTATED_SIZE="$("$wc_bin" -c <"$machine_artifact")"
export BUCK2_MACHINE_MUTATED_SRI="$($nix_bin hash file --sri --type sha256 "$machine_artifact")"
: >"$red_log"
if "$nix_bin" build --impure --no-link --expr '
  let
    pkgs = import (builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_NIXPKGS")) { system = builtins.currentSystem; };
    contract = import (builtins.toPath (builtins.getEnv "BUCK2_PRODUCT_CONTRACT"));
    importArtifact = import (builtins.toPath (builtins.getEnv "BUCK2_PRODUCT_IMPORTER")) { inherit pkgs; };
    original = builtins.fromJSON (builtins.readFile (builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_DESCRIPTOR_STORE")));
    descriptor = original // {
      payload = original.payload // {
        sizeBytes = builtins.fromJSON (builtins.getEnv "BUCK2_MACHINE_MUTATED_SIZE");
        digest = original.payload.digest // { sri = builtins.getEnv "BUCK2_MACHINE_MUTATED_SRI"; };
      };
    };
  in importArtifact {
    inherit descriptor;
    expectedDescriptorDigest = contract.descriptorDigest descriptor;
    expectedPlatform = { os = "linux"; architecture = "x86_64"; abi = "glibc"; };
    artifact = builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_MACHINE_ARTIFACT_STORE");
  }
' >/dev/null 2>"$red_log"; then
  echo "importer accepted an artifact whose real ELF machine contradicts its own descriptor" >&2
  exit 1
fi
"$grep_bin" -F "ELF machine mismatch" "$red_log" >/dev/null || { "$awk_bin" '{ print "elf-red-log: " $0 }' "$red_log" >&2; echo "ELF machine RED missed its asserted seam" >&2; exit 1; }
echo "buck2-megarepo-product-e2e: ELF MACHINE RED PASS entrypoint=$machine_entrypoint"
"$rm_bin" -rf "$machine_dir"

imported="$($nix_bin build --impure --no-link --print-out-paths --expr '
  let
    pkgs = import (builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_NIXPKGS")) { system = builtins.currentSystem; };
    contract = import (builtins.toPath (builtins.getEnv "BUCK2_PRODUCT_CONTRACT"));
    importArtifact = import (builtins.toPath (builtins.getEnv "BUCK2_PRODUCT_IMPORTER")) { inherit pkgs; };
    descriptorPath = builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_DESCRIPTOR_STORE");
    descriptor = builtins.fromJSON (builtins.readFile descriptorPath);
  in importArtifact {
    inherit descriptor;
    expectedDescriptorDigest = contract.descriptorDigest descriptor;
    expectedPlatform = { os = "linux"; architecture = "x86_64"; abi = "glibc"; };
    artifact = builtins.storePath (builtins.getEnv "BUCK2_PRODUCT_ARTIFACT_STORE");
  }
')"
runtime_output="$(env -i PATH=/nonexistent "$imported/bin/mr" --version)"
[ -n "$runtime_output" ] || { echo "imported mr runtime smoke produced no version" >&2; exit 1; }
echo "buck2-megarepo-product-e2e: RUNTIME PASS imported=$imported"
