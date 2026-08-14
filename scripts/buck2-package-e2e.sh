#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-package-e2e.sh REPO_ROOT BUCK2_BIN TARGET}"
buck2_bin="${2:?usage: buck2-package-e2e.sh REPO_ROOT BUCK2_BIN TARGET}"
target="${3:?usage: buck2-package-e2e.sh REPO_ROOT BUCK2_BIN TARGET}"
awk_bin="${AWK_BIN:-awk}"
nix_bin="${NIX_BIN:-nix}"
jq_bin="${JQ_BIN:-jq}"

case "$target" in
  //*:* ) ;;
  * ) echo "buck2-package-e2e: target must be a canonical root-cell label" >&2; exit 64 ;;
esac

build_output="$("$buck2_bin" \
  build \
    "$target" "$target[descriptor]" \
    --show-full-output --local-only --no-remote-cache)"

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

# This output is an input-plan evidence fixture, not an admitted build product.
# Verify its own provisional package-evidence shape and payload identity without
# routing it through the strict product importer.
"$jq_bin" -e '
  .schemaVersion == 1 and
  .kind == "buck2-package-evidence" and
  .provenance.producer == "effect-utils/buck2/package-evidence@1" and
  .entrypoints == ["bin/package-evidence"]
' "$descriptor" >/dev/null
declared_digest="$("$jq_bin" -r '.artifact.digest.sri' "$descriptor")"
actual_digest="$("$nix_bin" hash file --type sha256 --sri "$artifact")"
[ "$declared_digest" = "$actual_digest" ] || {
  echo "buck2-package-e2e: package evidence payload digest mismatch" >&2
  exit 1
}

echo "buck2-package-e2e: PASS target=$target admission=not-attempted"
