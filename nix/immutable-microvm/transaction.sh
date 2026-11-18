set -euo pipefail
umask 077
exec 9>"$CONTROL/lock"
flock -n 9 || exit 75
select_release() {
  ln -sfn "$1" "$ROOTS/current.next"
  mv -Tf "$ROOTS/current.next" "$ROOTS/current"
  sync -f "$ROOTS"
}
record() {
  jq -n --arg outcome "$1" --arg release "$2" '{outcome:$outcome,release:$release}' > "$CONTROL/receipt.next"
  sync -f "$CONTROL/receipt.next"
  mv -Tf "$CONTROL/receipt.next" "$CONTROL/receipt.json"
  sync -f "$CONTROL"
}
probe() {
  local release="$1" previous_boot="$2" deadline=$((SECONDS + HEALTH_TIMEOUT)) nonce
  while (( SECONDS < deadline )); do
    nonce=$(cat /proc/sys/kernel/random/uuid)
    if curl --noproxy '*' --fail --silent --max-time 2 "$READY_URL?nonce=$nonce" > "$CONTROL/health.next" &&
      jq -e --slurpfile manifest "$release/manifest.json" --arg nonce "$nonce" --arg old "$previous_boot" '
        .release == $manifest[0].release and .catalogDigest == $manifest[0].catalogDigest and
        .epoch == $manifest[0].epoch and .nonce == $nonce and .ready == true and
        (.bootNonce | type == "string" and length > 0) and .bootNonce != $old
      ' "$CONTROL/health.next" > /dev/null; then
      sync -f "$CONTROL/health.next"
      mv -Tf "$CONTROL/health.next" "$CONTROL/health.json"
      sync -f "$CONTROL"
      return 0
    fi
    sleep 1
  done
  return 1
}
validate_release() {
  test -d "$1/runner"
  test -x "$1/runner/bin/microvm-run"
  jq -e 'keys == ["catalogDigest","epoch","release"] and all(.[]; type == "string" and length > 0)' "$1/manifest.json" > /dev/null
  case "$(readlink -f "$1")" in /nix/store/*) ;; *) exit 65 ;; esac
}
if [ "${1:-}" = verify ]; then
  probe "$(readlink -f "$ROOTS/current")" ""
  exit 0
fi
if [ "${1:-}" = rescue ]; then
  test -e "$CONTROL/pending.json" || exit 0
  prior=$(jq -er .prior "$CONTROL/pending.json")
  validate_release "$prior"
  systemctl stop "$VM_UNIT"
  select_release "$prior"
  if systemctl start "$VM_UNIT" && probe "$prior" ""; then
    record recovered "$prior"
    rm "$CONTROL/pending.json"
    rm -f "$ROOTS/candidate"
    sync -f "$CONTROL"
    sync -f "$ROOTS"
    exit 0
  fi
  systemctl stop "$VM_UNIT"
  record degraded "$prior"
  exit 70
fi
if [ "${1:-}" = recover ]; then
  if [ -e "$CONTROL/pending.json" ]; then
    prior=$(jq -er .prior "$CONTROL/pending.json")
    validate_release "$prior"
    select_release "$prior"
    record recovered "$prior"
    rm "$CONTROL/pending.json"
    sync -f "$CONTROL"
  elif [ ! -e "$ROOTS/current" ]; then
    validate_release "$INITIAL_RELEASE"
    select_release "$INITIAL_RELEASE"
  fi
  exit 0
fi
candidate=$(readlink -f "$1")
validate_release "$candidate"
prior=$(readlink -f "$ROOTS/current")
validate_release "$prior"
# An incompatible state writer must never touch the retained prior's disk.
test "$(jq -r .epoch "$candidate/manifest.json")" = "$(jq -r .epoch "$prior/manifest.json")"
test ! -e "$CONTROL/pending.json"
old_boot=$(jq -r '.bootNonce // ""' "$CONTROL/health.json" 2>/dev/null || true)
ln -sfn "$prior" "$ROOTS/prior"
ln -sfn "$candidate" "$ROOTS/candidate"
sync -f "$ROOTS"
jq -n --arg prior "$prior" --arg candidate "$candidate" '{prior:$prior,candidate:$candidate}' > "$CONTROL/pending.next"
sync -f "$CONTROL/pending.next"
mv -Tf "$CONTROL/pending.next" "$CONTROL/pending.json"
sync -f "$CONTROL"
# systemd owns this process, independent of the SSH/deploy client lifetime.
select_release "$candidate"
if systemctl restart "$VM_UNIT" && probe "$candidate" "$old_boot"; then
  record committed "$candidate"
else
  failed_boot=$(jq -r '.bootNonce // ""' "$CONTROL/health.next" 2>/dev/null || true)
  systemctl stop "$VM_UNIT"
  select_release "$prior"
  if systemctl start "$VM_UNIT" && probe "$prior" "$failed_boot"; then
    record rolled-back "$prior"
  else
    systemctl stop "$VM_UNIT"
    record degraded "$prior"
    # Retain the journal and roots for explicit recovery; no retry loop.
    exit 70
  fi
fi
rm "$CONTROL/pending.json" "$ROOTS/candidate"
sync -f "$CONTROL"
sync -f "$ROOTS"
test "$(jq -r .outcome "$CONTROL/receipt.json")" = committed
