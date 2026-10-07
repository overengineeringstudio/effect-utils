#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd -P)"
BUN="${BUN_BIN:-$(command -v bun)}"
NIX="${NIX_BIN:-$(command -v nix)}"
NIX_STORE="${NIX_STORE_BIN:-$(command -v nix-store)}"
TEMP_ROOT="$(mktemp -d)"
TEMP_ROOT="$(cd "$TEMP_ROOT" && pwd -P)"
TEST_HOME="$TEMP_ROOT/home"
mkdir -p "$TEST_HOME"
declare -a child_pids=()
cleanup() {
  local pid
  for pid in "${child_pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${child_pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  chmod -R u+w "$TEMP_ROOT" 2>/dev/null || true
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fail() { echo "FAIL: $*" >&2; exit 1; }
export NIX_FLAKE_REF="${NIX_FLAKE_REF:-git+file://$ROOT?shallow=1}"
export CAPABILITY_FIXTURE_ROOT="$ROOT" CAPABILITY_FIXTURE_NIX="$TESTS_DIR/buck2-capability-fixture/profiles.nix"
profiles_file="$("$NIX" build --impure --no-link --print-out-paths --expr '
  let
    flake = builtins.getFlake (builtins.getEnv "NIX_FLAKE_REF");
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in import (builtins.toPath (builtins.getEnv "CAPABILITY_FIXTURE_NIX")) {
    inherit pkgs;
    repoRoot = builtins.toPath (builtins.getEnv "CAPABILITY_FIXTURE_ROOT");
    versions = [ "one" "two" "three" "four" "five" ];
  }
')"
PLATFORM="$(jq -er '.platform' "$profiles_file")"
versions=(one two three four five)
profile() { jq -er --arg version "$1" '.profiles[$version]' "$profiles_file"; }
generation() { "$BUN" -e 'console.log(require("fs").readFileSync(process.argv[1], "utf8").match(/^GENERATION = "([0-9a-f]{64})"$/m)[1])' "$1/defs.bzl"; }
publish() {
  HOME="$TEST_HOME" "$BUN" "$ROOT/scripts/buck2-capability-publish.ts" --root "$1" --profile "$(profile "$2")" --nix-store "${3:-$NIX_STORE}"
}
state_root() { printf '%s/.buck/buckd/%s\n' "$TEST_HOME" "${1#/}"; }
assert_result() {
  local result="$1" version="$2" count="$3" deferred="$4"
  jq -e --arg gen "$(generation "$(profile "$version")")" --argjson count "$count" --argjson deferred "$deferred" '
    .generation == $gen and .retainedCount == $count and .pruningDeferred == $deferred
  ' "$result" >/dev/null || fail "incorrect publication result for $version"
}
assert_retained() {
  local root="$1" count="$2" version gen directory root_link target manifest expected
  [ -d "$root/.buck2/capabilities" ] && [ ! -L "$root/.buck2/capabilities" ] || fail "capability cell is not a stable real directory"
  "$BUN" -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.argv[1];
    const count = Number(process.argv[2]);
    const names = fs.readdirSync(path.join(root, "generations"));
    const current = fs.readFileSync(path.join(root, "defs.bzl"), "utf8").match(/^GENERATION = "([0-9a-f]{64})"$/m)[1];
    if (names.length !== count || !names.includes(current) || names.some((name) => !/^[0-9a-f]{64}$/.test(name))) process.exit(1);
  ' "$root/.buck2/capabilities" "$count" || fail "generation set does not match selected defs or expected retained count"
  for version in "${versions[@]}"; do
    target="$(profile "$version")"
    gen="$(generation "$target")"
    directory="$root/.buck2/capabilities/generations/$gen"
    root_link="$root/.buck2/capability-roots/$gen"
    "$NIX_STORE" --query --roots "$target" >"$TEMP_ROOT/gc-roots"
    if [ -d "$directory" ]; then
      [ "$(readlink "$root_link")" = "$target" ] || fail "retained generation $gen lost its profile root"
      grep -Fq -- "$root_link" "$TEMP_ROOT/gc-roots" || fail "retained generation $gen is not registered with the real Nix GC"
      manifest="$directory/$PLATFORM/archive-tool/manifest.json"
      expected="$(jq -er '.executableStorePath' "$manifest")"
      [ "$(readlink "$directory/$PLATFORM/archive-tool/executable")" = "$expected" ] || fail "executable link was rewritten through aggregate output"
      case "$expected" in /nix/store/*buck2-capabilities*) fail "input uses aggregate projection" ;; /nix/store/*) ;; *) fail "input is not an absolute tool store path" ;; esac
      expected="$(jq -er '.directoryStorePath' "$directory/$PLATFORM/support-directory/manifest.json")"
      [ "$(readlink "$directory/$PLATFORM/support-directory/directory")" = "$expected" ] || fail "directory link no longer names its exact store input"
    else
      [ ! -e "$root_link" ] && [ ! -L "$root_link" ] || fail "pruned generation still has its indirect root"
      if grep -Fq -- "$root_link" "$TEMP_ROOT/gc-roots"; then fail "Nix still considers the pruned fixture root live"; fi
    fi
  done
}

# Both state and PIDs below are explicitly test fixtures. Production Buck is
# exercised in buck2-capability-daemon.test.sh; no processes are scraped here.
live="$TEMP_ROOT/live-state"
mkdir -p "$live" "$(state_root "$live")/alternate-isolation"
printf '%s\n' "$$" >"$(state_root "$live")/alternate-isolation/buckd.pid"
count=0
for version in "${versions[@]}"; do
  count=$((count + 1))
  publish "$live" "$version" >"$TEMP_ROOT/live-$version.json"
  assert_result "$TEMP_ROOT/live-$version.json" "$version" "$count" true
done
assert_retained "$live" 5
# Even after a different isolation is incomplete, every generation remains.
mkdir -p "$(state_root "$live")/incomplete-isolation"
rm "$(state_root "$live")/alternate-isolation/buckd.pid"
rmdir "$(state_root "$live")/alternate-isolation"
publish "$live" one >"$TEMP_ROOT/missing-pid.json"
assert_result "$TEMP_ROOT/missing-pid.json" one 5 true
printf 'not-a-pid\n' >"$(state_root "$live")/incomplete-isolation/buckd.pid"
publish "$live" two >"$TEMP_ROOT/invalid-pid.json"
assert_result "$TEMP_ROOT/invalid-pid.json" two 5 true
assert_retained "$live" 5
rm -rf "$(state_root "$live")"
publish "$live" three >"$TEMP_ROOT/daemon-free.json"
assert_result "$TEMP_ROOT/daemon-free.json" three 3 false
assert_retained "$live" 3
for version in one two three; do
  [ -d "$live/.buck2/capabilities/generations/$(generation "$(profile "$version")")" ] || fail "daemon-free pruning ignored last-publication recency"
done

# Migration preserves both real generation trees and their per-tool links.
migration="$TEMP_ROOT/migration"
mkdir -p "$migration/.buck2"
ln -s "$(profile one)" "$migration/.buck2/capabilities"
publish "$migration" two >"$TEMP_ROOT/migration.json"
assert_result "$TEMP_ROOT/migration.json" two 2 false
assert_retained "$migration" 2
inode_before="$($BUN -e 'console.log(require("fs").lstatSync(process.argv[1]).ino)' "$migration/.buck2/capabilities")"
publish "$migration" one >"$TEMP_ROOT/republication.json"
inode_after="$($BUN -e 'console.log(require("fs").lstatSync(process.argv[1]).ino)' "$migration/.buck2/capabilities")"
[ "$inode_before" = "$inode_after" ] || fail "steady publication replaced the stable cell directory"
assert_result "$TEMP_ROOT/republication.json" one 2 false
assert_retained "$migration" 2

# A real nix-store delegation barrier makes competing CLI processes overlap
# while the first production publisher is known to hold its native flock.
# The wrapper never manufactures store results or GC registrations.
cat >"$TEMP_ROOT/gated-nix-store" <<'GATE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$$" >"$ROOTING_READY"
IFS= read -r _ <"$ROOTING_RELEASE"
exec "$REAL_NIX_STORE" "$@"
GATE
chmod +x "$TEMP_ROOT/gated-nix-store"
cat >"$TEMP_ROOT/assert-flock-held.ts" <<'LOCK'
import { dlopen } from 'bun:ffi'
import { closeSync, openSync } from 'node:fs'
const native = dlopen(process.platform === 'linux' ? 'libc.so.6' : '/usr/lib/libSystem.B.dylib', {
  flock: { args: ['i32', 'i32'], returns: 'i32' },
})
const fd = openSync(process.argv[2], 'a')
const result = native.symbols.flock(fd, 6) // LOCK_EX | LOCK_NB
closeSync(fd)
native.close()
if (result === 0) process.exit(1)
LOCK
export REAL_NIX_STORE="$NIX_STORE" ROOTING_READY="$TEMP_ROOT/rooting-ready" ROOTING_RELEASE="$TEMP_ROOT/rooting-release"
mkfifo "$ROOTING_READY" "$ROOTING_RELEASE"
exec 8<>"$ROOTING_READY"
concurrent="$TEMP_ROOT/concurrent"
mkdir -p "$concurrent" "$(state_root "$concurrent")/uncertain-isolation"
HOME="$TEST_HOME" "$BUN" "$ROOT/scripts/buck2-capability-publish.ts" --root "$concurrent" --profile "$(profile one)" --nix-store "$TEMP_ROOT/gated-nix-store" >"$TEMP_ROOT/concurrent-one.json" &
first_publisher=$!
child_pids+=("$first_publisher")
read -r -t 30 -u 8 rooting_pid || fail "production publisher did not reach real Nix rooting barrier"
child_pids+=("$rooting_pid")
"$BUN" "$TEMP_ROOT/assert-flock-held.ts" "$concurrent/.buck2/capabilities.lock" || fail "production publisher did not hold native flock across rooting"
declare -a competing_pids=()
for version in two three four five; do
  HOME="$TEST_HOME" "$BUN" "$ROOT/scripts/buck2-capability-publish.ts" --root "$concurrent" --profile "$(profile "$version")" --nix-store "$NIX_STORE" >"$TEMP_ROOT/concurrent-$version.json" &
  competing_pids+=("$!")
  child_pids+=("$!")
done
printf 'release\n' >"$ROOTING_RELEASE"
wait "$first_publisher" || fail "first competing publisher failed"
for pid in "${competing_pids[@]}"; do wait "$pid" || fail "competing production publisher failed"; done
child_pids=()
assert_retained "$concurrent" 5
for version in "${versions[@]}"; do
  jq -e --arg gen "$(generation "$(profile "$version")")" '.generation == $gen and .pruningDeferred == true and .retainedCount >= 1 and .retainedCount <= 5' "$TEMP_ROOT/concurrent-$version.json" >/dev/null
done
"$BUN" -e '
  const fs = require("fs");
  const path = require("path");
  const dir = process.argv[1];
  const receipts = fs.readdirSync(dir).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
  if (receipts.length !== 5 || new Set(receipts).size !== 5 || receipts.some((value) => !Number.isSafeInteger(value) || value < 1)) process.exit(1);
' "$concurrent/.buck2/capability-publications" || fail "competing publishers produced inconsistent generation receipts"
rm -rf "$(state_root "$concurrent")"
publish "$concurrent" one >"$TEMP_ROOT/concurrent-pruned.json"
assert_result "$TEMP_ROOT/concurrent-pruned.json" one 3 false
assert_retained "$concurrent" 3

# Kill the actual publisher while it holds flock, then publish again. The
# delegated rooting subprocess is also test-owned and explicitly reaped.
crash="$TEMP_ROOT/crash"
mkdir -p "$crash"
HOME="$TEST_HOME" "$BUN" "$ROOT/scripts/buck2-capability-publish.ts" --root "$crash" --profile "$(profile one)" --nix-store "$TEMP_ROOT/gated-nix-store" >"$TEMP_ROOT/crashed.json" &
crashed_publisher=$!
child_pids+=("$crashed_publisher")
read -r -t 30 -u 8 rooting_pid || fail "crash publisher did not reach rooting barrier"
child_pids+=("$rooting_pid")
"$BUN" "$TEMP_ROOT/assert-flock-held.ts" "$crash/.buck2/capabilities.lock" || fail "crash publisher did not acquire native flock"
kill -KILL "$crashed_publisher" "$rooting_pid"
wait "$crashed_publisher" 2>/dev/null || true
child_pids=()
publish "$crash" two >"$TEMP_ROOT/crash-recovery.json"
assert_result "$TEMP_ROOT/crash-recovery.json" two 1 false
assert_retained "$crash" 1
exec 8>&-

# Corruption cannot silently change immutable contents or select new defs.
corrupt_generation="$(generation "$(profile one)")"
cp "$migration/.buck2/capabilities/defs.bzl" "$TEMP_ROOT/defs-before-corruption"
chmod u+w "$migration/.buck2/capabilities/generations/$corrupt_generation/$PLATFORM/archive-tool/manifest.json"
printf '{"corrupt":true}\n' >"$migration/.buck2/capabilities/generations/$corrupt_generation/$PLATFORM/archive-tool/manifest.json"
corruption_exit=0
publish "$migration" one >"$TEMP_ROOT/corrupt.stdout" 2>"$TEMP_ROOT/corrupt.stderr" || corruption_exit=$?
[ "$corruption_exit" -ne 0 ] || fail "publisher accepted changed contents under an existing generation identity"
grep -Fq 'Immutable capability generation has changed contents' "$TEMP_ROOT/corrupt.stderr" || fail "generation corruption was not diagnosed"
cmp -s "$TEMP_ROOT/defs-before-corruption" "$migration/.buck2/capabilities/defs.bzl" || fail "failed corrupt publication changed selected defs"

jq -nc '{test:"publisher-contracts",concurrentPublishers:5,nativeFlock:true,crashReleasedLock:true,liveRetainedCount:5,unknownStateDeferred:true,daemonFreeRetainedCount:3,migratedSymlink:true,registeredNixGCRoots:true,immutableCorruptionRejected:true}'
echo 'Buck capability publisher contracts passed.'
