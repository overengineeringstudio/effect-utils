#!/usr/bin/env bash
set -euo pipefail

pnpm_bin="$(realpath "${PNPM_BIN:-$(command -v pnpm)}")"
root_base="$(realpath "${ROOT_BASE:-/tmp}")"
store_base="$(realpath "${STORE_BASE:-/tmp}")"
root_tmp="$(mktemp -d "$root_base/.pnpm-prune-capability-root.XXXXXX")"
store_tmp="$(mktemp -d "$store_base/.pnpm-prune-capability-store.XXXXXX")"
trap 'rm -rf "$root_tmp" "$store_tmp"' EXIT
root="$root_tmp/root"
store="$store_tmp/store"
mkdir -p "$root" "$store"

cat >"$root/package.json" <<'JSON'
{
  "name": "pnpm-prune-capability",
  "private": true,
  "packageManager": "pnpm@11.8.0",
  "dependencies": {
    "is-number": "7.0.0"
  }
}
JSON
cat >"$root/pnpm-workspace.yaml" <<'YAML'
packages:
  - .
YAML

pnpm_version="$(cd "$root" && "$pnpm_bin" --version)"
if [ -n "${EXPECTED_PNPM_VERSION:-}" ] && [ "$pnpm_version" != "$EXPECTED_PNPM_VERSION" ]; then
  printf 'pnpm version mismatch: expected %s, got %s from %s\n' "$EXPECTED_PNPM_VERSION" "$pnpm_version" "$pnpm_bin" >&2
  exit 1
fi

(
  cd "$root"
  "$pnpm_bin" install \
  --ignore-scripts \
  --config.enable-global-virtual-store=false \
  --config.virtual-store-dir=node_modules/.pnpm \
  --config.package-import-method=auto \
  --config.store-dir="$store" \
  --reporter=silent
)

root_file="$root/node_modules/.pnpm/is-number@7.0.0/node_modules/is-number/index.js"
test -f "$root_file"
root_device="$(stat -c %d "$root_file")"
root_inode="$(stat -c %i "$root_file")"
root_nlink="$(stat -c %h "$root_file")"
store_alias="$(find "$store/v11/files" -type f -inum "$root_inode" -print -quit)"
test -n "$store_alias"
test "$(stat -c %d "$store_alias")" = "$root_device"
test "$root_nlink" -ge 2

before_kib="$(du -sk "$store" | awk '{print $1}')"
(cd "$root" && "$pnpm_bin" store prune --config.store-dir="$store" --reporter=silent)
after_live_prune_kib="$(du -sk "$store" | awk '{print $1}')"
test -f "$store_alias"
test "$(node -p "require('$root/node_modules/is-number')(42)")" = true

rm -rf "$root/node_modules"
(cd "$root" && "$pnpm_bin" store prune --config.store-dir="$store" --reporter=silent)
after_removed_prune_kib="$(du -sk "$store" | awk '{print $1}')"
test ! -e "$store_alias"

printf '{"schema":"dependency-materialization-verification/v0","kind":"host-capability","surface":"pnpm-store-prune","host":"%s","platform":"%s","filesystem":"%s","pnpm":"%s","pnpmBin":"%s","packageImportMethod":"auto","rootBase":"%s","storeBase":"%s","rootDevice":%s,"storeDevice":%s,"rootInode":%s,"rootNlink":%s,"storeAliasFound":true,"liveRootSurvivedPrune":true,"removedRootCacheEvicted":true,"beforeKiB":%s,"afterLivePruneKiB":%s,"afterRemovedPruneKiB":%s,"destructivePruneSafe":true}\n' \
  "$(hostname -s)" "$(uname -m)-linux" "$(findmnt -n -o FSTYPE --target "$root_base")" "$pnpm_version" "$pnpm_bin" \
  "$root_base" "$store_base" "$root_device" "$(stat -c %d "$store")" "$root_inode" "$root_nlink" "$before_kib" "$after_live_prune_kib" "$after_removed_prune_kib"
