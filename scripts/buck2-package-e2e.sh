#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-package-e2e.sh REPO_ROOT LAUNCHER TARGET}"
launcher="${2:?usage: buck2-package-e2e.sh REPO_ROOT LAUNCHER TARGET}"
target="${3:?usage: buck2-package-e2e.sh REPO_ROOT LAUNCHER TARGET}"
shift 3
buck_args=("$@")
evidence_dir="$repo_root/tmp/buck2-evidence"
awk_bin="${AWK_BIN:-awk}"
nix_bin="${NIX_BIN:-nix}"
nix_store_bin="${NIX_STORE_BIN:-nix-store}"
jq_bin="${JQ_BIN:-jq}"
entrypoint="${BUCK2_E2E_ENTRYPOINT:-package-evidence}"
runtime_argument="${BUCK2_E2E_RUNTIME_ARGUMENT:-}"
expected_substring="${BUCK2_E2E_EXPECTED_SUBSTRING:-}"
runtime_abi="${BUCK2_E2E_RUNTIME_ABI:-portable}"
nixpkgs_path="${BUCK2_E2E_NIXPKGS:?BUCK2_E2E_NIXPKGS must name the pinned nixpkgs store path}"
importer_root="${BUCK2_E2E_IMPORTER_ROOT:?BUCK2_E2E_IMPORTER_ROOT must name the Buck artifact importer directory store path}"
runtime_args=()
if [ -n "$runtime_argument" ]; then runtime_args=("$runtime_argument"); fi
run_id="package-e2e-$$-$RANDOM"
receipt="$evidence_dir/$run_id/receipt.json"

case "$target" in
  //*:* ) ;;
  * ) echo "buck2-package-e2e: target must be a canonical root-cell label" >&2; exit 64 ;;
esac

build_output="$("$launcher" \
  --evidence-dir "$evidence_dir" \
  --run-id "$run_id" \
  --print-command \
  -- build "$target" "$target[descriptor]" \
    "${buck_args[@]}" \
    --show-full-output --local-only --no-remote-cache)"

[ -f "$receipt" ] || {
  echo "buck2-package-e2e: launcher did not write the expected receipt" >&2
  exit 1
}
"$jq_bin" -e '
  .schema == "buck-run-receipt/v1" and
  .status.success == true and
  .status.exitCode == 0 and
  .observation.complete == true and
  .observation.verdict == "complete" and
  .observation.reasons == [] and
  .observation.whatRan.exitCode == 0 and
  .observation.whatRan.parseComplete == true and
  .observation.whatRan.semanticComplete == true and
  .observation.materialized.exitCode == 0 and
  .observation.materialized.parseComplete == true and
  .observation.materialized.semanticComplete == true
' "$receipt" >/dev/null || {
  echo "buck2-package-e2e: launcher receipt is unsuccessful or observationally incomplete" >&2
  exit 1
}

# Buck renders canonical root-cell labels as `root//...` even when the caller
# supplies the accepted shorthand `//...`.
output_label="root$target"
artifact="$(printf '%s\n' "$build_output" | "$awk_bin" -v label="$output_label" '$1 == label { print $2 }')"
descriptor="$(printf '%s\n' "$build_output" | "$awk_bin" -v label="$output_label[descriptor]" '$1 == label { print $2 }')"
[ -n "$artifact" ] && [ -f "$artifact" ] || {
  echo "buck2-package-e2e: Buck did not report the artifact output" >&2
  exit 1
}
[ -n "$descriptor" ] && [ -f "$descriptor" ] || {
  echo "buck2-package-e2e: Buck did not report the descriptor output" >&2
  exit 1
}

export BUCK2_E2E_NIXPKGS="$nixpkgs_path"
export BUCK2_E2E_IMPORTER_ROOT="$importer_root"
# A sandboxed Nix build cannot read Buck's mutable output tree directly. Admit
# the two immutable files to the local store first, then make the importer
# independently verify the descriptor's digest, size, platform, and archive.
export BUCK2_E2E_ARTIFACT="$($nix_bin store add --mode flat --name artifact.tar "$artifact")"
export BUCK2_E2E_DESCRIPTOR="$($nix_bin store add --mode flat --name descriptor.json "$descriptor")"
export BUCK2_E2E_RUNTIME_ABI="$runtime_abi"
imported="$("$nix_bin" build --impure --no-link --print-out-paths --expr '
  let
    nixpkgs = builtins.storePath (builtins.getEnv "BUCK2_E2E_NIXPKGS");
    importerRoot = builtins.storePath (builtins.getEnv "BUCK2_E2E_IMPORTER_ROOT");
    pkgs = import nixpkgs { system = builtins.currentSystem; };
    importArtifact = import (importerRoot + "/buck2-artifact-import.nix") { inherit pkgs; };
    artifact = builtins.storePath (builtins.getEnv "BUCK2_E2E_ARTIFACT");
    descriptorPath = builtins.storePath (builtins.getEnv "BUCK2_E2E_DESCRIPTOR");
    descriptor = builtins.fromJSON (builtins.readFile descriptorPath);
    expectedRuntimeAbi = builtins.getEnv "BUCK2_E2E_RUNTIME_ABI";
  in importArtifact {
    inherit descriptor expectedRuntimeAbi;
    inherit artifact;
  }
')"

runtime_stdout="$(env -i PATH=/nonexistent "$imported/bin/$entrypoint" "${runtime_args[@]}")"
case "$runtime_stdout" in
  *"$expected_substring"*) ;;
  *)
    echo "buck2-package-e2e: runtime output lacks expected marker '$expected_substring': $runtime_stdout" >&2
    exit 1
    ;;
esac
runtime_references="$("$nix_store_bin" --query --references "$imported")"
runtime_magic="$(${HEAD_BIN:-head} -c 4 "$imported/bin/$entrypoint" \
  | ${OD_BIN:-od} -An -tx1 \
  | ${TR_BIN:-tr} -d ' \n')"
if [ "$runtime_magic" = 7f454c46 ]; then
  [ -n "$runtime_references" ] || {
    echo "buck2-package-e2e: imported ELF lacks its Nix-owned runtime closure" >&2
    exit 1
  }
else
  [ -z "$runtime_references" ] || {
    echo "buck2-package-e2e: non-ELF artifact acquired unexpected Nix references" >&2
    exit 1
  }
fi

echo "buck2-package-e2e: PASS target=$target entrypoint=$entrypoint imported=$imported runtime_relocated=$([ "$runtime_magic" = 7f454c46 ] && printf true || printf false)"
