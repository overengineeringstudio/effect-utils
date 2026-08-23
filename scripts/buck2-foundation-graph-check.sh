#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-foundation-graph-check.sh REPO_ROOT BUCK2_BIN}"
buck2_bin="${2:?usage: buck2-foundation-graph-check.sh REPO_ROOT BUCK2_BIN}"
rg_bin="${RG_BIN:-rg}"
find_bin="${FIND_BIN:-find}"
grep_bin="${GREP_BIN:-grep}"
awk_bin="${AWK_BIN:-awk}"
mkdir_bin="${MKDIR_BIN:-mkdir}"

if "$find_bin" "$repo_root/buck2" -type f -name '*.py' -print -quit | "$grep_bin" -q .; then
  echo "buck2-foundation-graph-check: repository-owned Python remains under buck2/" >&2
  exit 1
fi
if "$rg_bin" -q 'python_(binary|library|test)|cpython(_archive)?' \
  "$repo_root/buck2" "$repo_root/toolchains" --glob 'BUCK' --glob '*.bzl'; then
  echo "buck2-foundation-graph-check: Python rules or CPython labels remain in the foundation" >&2
  exit 1
fi
if "$rg_bin" -q -U 'load\(\s*"(?://buck2(?:/|:)|:)' \
  "$repo_root/buck2" --glob '*.bzl' --glob 'BUCK'; then
  echo "buck2-foundation-graph-check: root-owned providers use caller-relative cross-cell loads" >&2
  exit 1
fi

$buck2_bin audit providers \
  --target-platforms root//buck2/platforms:host_platform \
  toolchains//:cross_cell_provider_identity >/dev/null
$buck2_bin audit providers \
  --target-platforms root//buck2/platforms:host_platform \
  toolchains//:cross_cell_product_identity >/dev/null
"$mkdir_bin" -p "$repo_root/tmp"
if $buck2_bin audit providers \
  --target-platforms root//buck2/platforms:linux_x86_64 \
  toolchains//:cross_cell_product_mismatch >"$repo_root/tmp/buck2-foundation-platform-mismatch.log" 2>&1; then
  echo "buck2-foundation-graph-check: mismatched product and executable platforms unexpectedly passed" >&2
  exit 1
fi
"$rg_bin" -F 'build_product executable platform' "$repo_root/tmp/buck2-foundation-platform-mismatch.log" >/dev/null

graph="$($buck2_bin cquery \
  'deps(//:buck2_foundation) + deps(//buck2/evidence:package_evidence)')"
if printf '%s\n' "$graph" | "$grep_bin" -Ei 'python|cpython' >/dev/null; then
  echo "buck2-foundation-graph-check: Python or CPython is reachable from foundation targets" >&2
  printf '%s\n' "$graph" | "$grep_bin" -Ei 'python|cpython' >&2
  exit 1
fi

for target in \
  toolchains//:closure_tool \
  toolchains//:package_evidence_tool; do
  printf '%s\n' "$graph" | "$awk_bin" -v target="$target" '$1 == target { found = 1 } END { exit !found }' || {
    echo "buck2-foundation-graph-check: missing configured execution edge: $target" >&2
    exit 1
  }
done

echo "buck2-foundation-graph-check: PASS owned_python=0 cpython_edges=0"
