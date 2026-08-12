#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?usage: buck2-foundation-graph-check.sh REPO_ROOT BUCK2_BIN}"
buck2_bin="${2:?usage: buck2-foundation-graph-check.sh REPO_ROOT BUCK2_BIN}"
stage0_config="${BUCK2_STAGE0_CONFIG:?BUCK2_STAGE0_CONFIG is required}"

if find "$repo_root/buck2" -type f -name '*.py' -print -quit | grep -q .; then
  echo "buck2-foundation-graph-check: repository-owned Python remains under buck2/" >&2
  exit 1
fi
if rg -n 'python_(binary|library|test)|cpython(_archive)?' \
  "$repo_root/buck2" "$repo_root/toolchains" --glob 'BUCK' --glob '*.bzl' | grep -q .; then
  echo "buck2-foundation-graph-check: Python rules or CPython labels remain in the foundation" >&2
  exit 1
fi

graph="$($buck2_bin cquery --config-file "$stage0_config" \
  'deps(//:buck2_foundation) + deps(//:portable_toolchain_evidence) + deps(//buck2/evidence:package_evidence)')"
if printf '%s\n' "$graph" | grep -Ei 'python|cpython' >/dev/null; then
  echo "buck2-foundation-graph-check: Python or CPython is reachable from foundation targets" >&2
  printf '%s\n' "$graph" | grep -Ei 'python|cpython' >&2
  exit 1
fi

for target in \
  toolchains//:closure_tool \
  toolchains//:package_evidence_tool \
  toolchains//:portable_toolchain \
  toolchains//:portable_toolchain_fixture; do
  printf '%s\n' "$graph" | awk -v target="$target" '$1 == target { found = 1 } END { exit !found }' || {
    echo "buck2-foundation-graph-check: missing configured execution edge: $target" >&2
    exit 1
  }
done

echo "buck2-foundation-graph-check: PASS owned_python=0 cpython_edges=0"
