#!/usr/bin/env bash
set -euo pipefail

pnpm_bin="${PNPM_BIN:-$(command -v pnpm)}"
tmp="$(mktemp -d /tmp/pnpm-prune-capability.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
root="$tmp/root"
store="$tmp/store"
mkdir -p "$root" "$store"

cat >"$root/package.json" <<'JSON'
{
  "name": "pnpm-prune-capability",
  "private": true,
  "dependencies": {
    "is-number": "7.0.0"
  }
}
JSON

"$pnpm_bin" --dir "$root" install \
  --ignore-scripts \
  --config.enable-global-virtual-store=false \
  --config.virtual-store-dir=node_modules/.pnpm \
  --config.package-import-method=auto \
  --config.store-dir="$store" \
  --reporter=silent

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
"$pnpm_bin" store prune --config.store-dir="$store" --reporter=silent
after_live_prune_kib="$(du -sk "$store" | awk '{print $1}')"
test -f "$store_alias"
test "$(node -p "require('$root/node_modules/is-number')(42)")" = true

rm -rf "$root/node_modules"
"$pnpm_bin" store prune --config.store-dir="$store" --reporter=silent
after_removed_prune_kib="$(du -sk "$store" | awk '{print $1}')"
test ! -e "$store_alias"

printf '{"schema":"dependency-materialization-verification/v0","kind":"host-capability","surface":"pnpm-store-prune","host":"%s","platform":"%s","filesystem":"%s","pnpm":"%s","packageImportMethod":"auto","rootDevice":%s,"storeDevice":%s,"rootInode":%s,"rootNlink":%s,"storeAliasFound":true,"liveRootSurvivedPrune":true,"removedRootCacheEvicted":true,"beforeKiB":%s,"afterLivePruneKiB":%s,"afterRemovedPruneKiB":%s,"destructivePruneSafe":true}\n' \
  "$(hostname -s)" "$(uname -m)-linux" "$(findmnt -n -o FSTYPE --target "$tmp")" "$("$pnpm_bin" --version)" \
  "$root_device" "$(stat -c %d "$store")" "$root_inode" "$root_nlink" "$before_kib" "$after_live_prune_kib" "$after_removed_prune_kib"
