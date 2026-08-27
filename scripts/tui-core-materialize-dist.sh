#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 REPO_ROOT" >&2
  exit 2
fi

root="$1"
package_dir="$root/packages/@overeng/tui-core"
dist="$package_dir/dist"
target="//packages/@overeng/tui-core:dist"
: "${BUCK2_BIN:?BUCK2_BIN must name the Buck2 executable}"

staging_root="$(mktemp -d "$package_dir/.dist-buck2.XXXXXX")"
staging="$staging_root/dist"
cleanup_staging() {
  status=$?
  trap - EXIT
  if [ -e "$staging_root" ]; then
    chmod -R u+w "$staging_root" || status=$?
    rm -rf -- "$staging_root" || status=$?
  fi
  exit "$status"
}
trap cleanup_staging EXIT

validate_dist() {
  local candidate="$1"
  local context="$2"
  if [ ! -d "$candidate" ]; then
    echo "$context did not materialize a directory: $candidate" >&2
    return 1
  fi
  if [ ! -f "$candidate/src/mod.d.ts" ]; then
    echo "$context is missing src/mod.d.ts: $candidate" >&2
    return 1
  fi
}

(
  cd "$root"
  "$BUCK2_BIN" build "$target" --out "$staging"
)
validate_dist "$staging" "Buck target $target"

had_dist=false
if [ -e "$dist" ] || [ -L "$dist" ]; then
  had_dist=true
  mv --exchange --no-copy -T "$staging" "$dist"
else
  mv --no-copy -T "$staging" "$dist"
fi

if ! validate_dist "$dist" "Published tui-core dist"; then
  echo "Published tui-core dist failed validation; restoring the previous dist" >&2
  if [ "$had_dist" = true ]; then
    mv --exchange --no-copy -T "$staging" "$dist"
  else
    rm -rf -- "$dist"
  fi
  exit 1
fi
