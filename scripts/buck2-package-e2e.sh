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

export BUCK2_E2E_REPO="$repo_root"
# A sandboxed Nix build cannot read Buck's mutable output tree directly. Admit
# the two immutable files to the local store first, then make the importer
# independently verify the descriptor's digest, size, platform, and archive.
export BUCK2_E2E_ARTIFACT="$($nix_bin store add --mode flat --name artifact.tar "$artifact")"
export BUCK2_E2E_DESCRIPTOR="$($nix_bin store add --mode flat --name descriptor.json "$descriptor")"
imported="$("$nix_bin" build --impure --no-link --print-out-paths --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_E2E_REPO");
    flake = builtins.getFlake (toString repo);
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    importArtifact = import (repo + "/nix/workspace-tools/lib/buck2-artifact-import.nix") { inherit pkgs; };
    artifact = builtins.storePath (builtins.getEnv "BUCK2_E2E_ARTIFACT");
    descriptorPath = builtins.storePath (builtins.getEnv "BUCK2_E2E_DESCRIPTOR");
    descriptor = builtins.fromJSON (builtins.readFile descriptorPath);
  in importArtifact {
    inherit descriptor;
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
[ -z "$("$nix_store_bin" --query --references "$imported")" ] || {
  echo "buck2-package-e2e: imported artifact retained Nix references" >&2
  exit 1
}

echo "buck2-package-e2e: PASS target=$target entrypoint=$entrypoint imported=$imported"
