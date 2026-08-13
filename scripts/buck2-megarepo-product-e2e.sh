#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-megarepo-product-e2e.sh REPO_ROOT LAUNCHER TARGET [BUCK_ARGS...]}"
launcher="${2:?launcher is required}"
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
included_non_src="$repo_root/packages/@overeng/tui-react/test/unit/tree.test.tsx"
red_log="$($mktemp_bin)"
source_backup="$($mktemp_bin)"
tampered_artifact="$($mktemp_bin)"
source_mutated=0
"$cp_bin" --preserve=mode,timestamps "$included_non_src" "$source_backup"
cleanup() {
  if [ "$source_mutated" = 1 ]; then "$cp_bin" --preserve=mode,timestamps "$source_backup" "$included_non_src"; fi
  "$rm_bin" -f "$red_log" "$source_backup" "$tampered_artifact"
}
trap cleanup EXIT
run_id="megarepo-product-e2e-$$-$RANDOM"
output="$($launcher --evidence-dir "$repo_root/tmp/buck2-evidence" --run-id "$run_id" --print-command -- build "$target" "$target[descriptor]" "$quality_target" "$@" --show-full-output --local-only --no-remote-cache)"
artifact="$(printf '%s\n' "$output" | "$awk_bin" -v label="root${target}" '$1 == label { print $2 }')"
descriptor="$(printf '%s\n' "$output" | "$awk_bin" -v label="root${target}[descriptor]" '$1 == label { print $2 }')"
[ -f "$artifact" ] && [ -f "$descriptor" ] || { echo "megarepo product outputs are missing" >&2; exit 1; }
echo "buck2-megarepo-product-e2e: QUALITY PASS target=$quality_target"

source_mutated=1
printf '\nconst buck2IncludedNonSrcRed: never = 1\n' >>"$included_non_src"
: >"$red_log"
if "$launcher" --evidence-dir "$repo_root/tmp/buck2-evidence" --run-id "$run_id-included-non-src-red" --print-command -- build "$quality_target" "$@" --local-only --no-remote-cache >"$red_log" 2>&1; then
  echo "mr_quality accepted an invalid included non-src project file" >&2
  exit 1
fi
"$grep_bin" -E "TS2322|not assignable" "$red_log" >/dev/null || { echo "included non-src RED missed its asserted typecheck seam" >&2; exit 1; }
"$cp_bin" --preserve=mode,timestamps "$source_backup" "$included_non_src"
source_mutated=0
"$launcher" --evidence-dir "$repo_root/tmp/buck2-evidence" --run-id "$run_id-included-non-src-green" --print-command -- build "$quality_target" "$@" --local-only --no-remote-cache >/dev/null
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
"$grep_bin" -F "ELF machine mismatch" "$red_log" >/dev/null || { echo "runtime RED missed its asserted seam" >&2; exit 1; }
echo "buck2-megarepo-product-e2e: RUNTIME RED PASS"

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
