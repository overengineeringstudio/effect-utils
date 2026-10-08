#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd -P)"
BUN="${BUN_BIN:-$(command -v bun)}"
NIX="${NIX_BIN:-$(command -v nix)}"
NIX_STORE_COMMAND="${NIX_STORE_BIN:-$(command -v nix-store)}"
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
retain_failure_evidence() {
  local evidence_base evidence name reference pid job_line job_id="" job_state=""
  evidence_base="${CAPABILITY_TEST_EVIDENCE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/buck2-cache-reports/capability-publisher}"
  umask 077
  mkdir -p "$evidence_base" || return 1
  evidence="$(mktemp -d "$evidence_base/capability-publisher.XXXXXX")" || return 1
  {
    printf 'fixture shell: $$=%s BASHPID=%s\n' "$$" "$BASHPID"
    for name in child_pids competing_pids first_publisher rooting_pid crashed_publisher; do
      if ! declare -p "$name" >/dev/null 2>&1; then continue; fi
      reference="$name[@]"
      for pid in "${!reference}"; do
        if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then printf 'owner=%s pid=%s\n' "$name" "$pid"; fi
      done
    done
    while IFS= read -r job_line; do
      if [[ "$job_line" =~ ^\[([0-9]+)\][+-]?[[:space:]]+([0-9]+)[[:space:]]+(Exit[[:space:]]+[0-9]+|[[:alpha:]]+) ]]; then
        job_id="${BASH_REMATCH[1]}"
        job_state="${BASH_REMATCH[3]}"
        printf 'job=%s pid=%s state=%s\n' "$job_id" "${BASH_REMATCH[2]}" "$job_state"
      elif [ -n "$job_id" ] && [[ "$job_line" =~ ^[[:space:]]+([0-9]+)[[:space:]] ]]; then
        printf 'job=%s pid=%s state=%s\n' "$job_id" "${BASH_REMATCH[1]}" "$job_state"
      fi
    done < <(LC_ALL=C jobs -l)
  } >"$evidence/shell-ownership.txt"
  "$BUN" -e '
    const fs = require("fs");
    const path = require("path");
    const { spawnSync } = require("child_process");
    const [temp, destination, shellPid, assertion, assertionRoot, expectedCount, ...pidArgs] = process.argv.slice(1);
    const fixturePid = Number(shellPid);
    const trackedPids = [...new Set(pidArgs.filter((pid) => /^[1-9][0-9]*$/.test(pid)).map(Number))];
    const errors = [];
    const collect = (label, operation) => {
      try { return operation(); } catch (error) { errors.push({ label, error: String(error) }); }
    };
    fs.mkdirSync(path.join(destination, "publisher-jsons"));
    fs.mkdirSync(path.join(destination, "generation-trees"));
    const cells = [];
    for (const name of fs.readdirSync(temp)) {
      const source = path.join(temp, name);
      if (name.endsWith(".json")) {
        collect(`publisher JSON ${name}`, () => fs.copyFileSync(source, path.join(destination, "publisher-jsons", name)));
      }
      if (!fs.lstatSync(source).isDirectory() || !fs.existsSync(path.join(source, ".buck2"))) continue;
      collect(`generation metadata ${name}`, () => {
        const cell = path.join(source, ".buck2", "capabilities");
        cells.push({
          fixture: name,
          generations: fs.readdirSync(path.join(cell, "generations")),
          definitions: fs.readFileSync(path.join(cell, "defs.bzl"), "utf8"),
        });
      });
      collect(`generation tree ${name}`, () => fs.cpSync(path.join(source, ".buck2"), path.join(destination, "generation-trees", name), { recursive: true, dereference: false }));
    }
    const native = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,comm="], { encoding: "utf8" });
    const processes = [];
    if (native.error || native.status !== 0) {
      errors.push({ label: "native PID ancestry", error: String(native.error || native.stderr) });
    } else {
      const rows = native.stdout.trim().split("\n").filter(Boolean).map((line) => {
        const [pid, parentPid, group, status, ...command] = line.trim().split(/\s+/);
        return { pid: Number(pid), parentPid: Number(parentPid), group: Number(group), status, command: command.join(" ") };
      });
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      const fixtureGroup = byPid.get(fixturePid)?.group;
      const selected = new Set([fixturePid, ...trackedPids]);
      // Same-group rows retain orphaned publishers without recording arguments
      // or environment; group membership alone is not an ownership claim.
      for (const row of rows) if (row.group === fixtureGroup) selected.add(row.pid);
      for (let changed = true; changed;) {
        changed = false;
        for (const row of rows) {
          if (selected.has(row.parentPid) && !selected.has(row.pid)) {
            selected.add(row.pid);
            changed = true;
          }
        }
      }
      for (const pid of [...selected]) {
        for (let row = byPid.get(pid); row && !selected.has(row.parentPid); row = byPid.get(row.parentPid)) selected.add(row.parentPid);
      }
      processes.push(...rows.filter((row) => selected.has(row.pid)));
    }
    collect("evidence retention", () => {
      const base = path.dirname(destination);
      const previous = fs.readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^capability-publisher\.[A-Za-z0-9]{6}$/.test(entry.name))
        .map((entry) => path.join(base, entry.name))
        .filter((directory) => directory !== destination)
        .flatMap((directory) => {
          try { return [{ directory, modified: fs.lstatSync(directory).mtimeMs }]; }
          catch (error) { if (error.code === "ENOENT") return []; throw error; }
        })
        .sort((left, right) => right.modified - left.modified || right.directory.localeCompare(left.directory));
      const makeDirectoriesWritable = (directory) => {
        try {
          const metadata = fs.lstatSync(directory);
          if (!metadata.isDirectory()) return;
          fs.chmodSync(directory, metadata.mode | 0o700);
          for (const name of fs.readdirSync(directory)) makeDirectoriesWritable(path.join(directory, name));
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      };
      for (const { directory } of previous.slice(4)) {
        makeDirectoriesWritable(directory);
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
    fs.writeFileSync(path.join(destination, "evidence.json"), JSON.stringify({
      observedAt: new Date().toISOString(), assertion, assertionRoot,
      expectedCount: expectedCount === "" ? null : Number(expectedCount),
      fixturePid, trackedPids, cells, processes, errors,
    }, null, 2) + "\n");
    if (errors.length) console.error("Failure evidence collection errors:", JSON.stringify(errors));
  ' "$TEMP_ROOT" "$evidence" "$BASHPID" "$1" "${root:-}" "${count:-}" \
    "${child_pids[@]}" "${competing_pids[@]-}" "${first_publisher:-}" \
    "${rooting_pid:-}" "${crashed_publisher:-}" || {
      printf 'Partial capability publisher failure evidence retained at %s\n' "$evidence" >&2
      return 1
    }
  printf 'Capability publisher failure evidence retained at %s\n' "$evidence" >&2
}
fail() {
  echo "FAIL: $*" >&2
  retain_failure_evidence "$*" || echo "FAIL: could not completely retain assertion evidence" >&2
  exit 1
}
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
  HOME="$TEST_HOME" "$BUN" "$ROOT/scripts/buck2-capability-publish.ts" --root "$1" --profile "$(profile "$2")" --nix-store "${3:-$NIX_STORE_COMMAND}"
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
    if (names.length !== count || !names.includes(current) || names.some((name) => !/^[0-9a-f]{64}$/.test(name))) {
      fs.writeFileSync(path.join(process.argv[3], "failed-generation-assertion.json"), JSON.stringify({
        observedAt: new Date().toISOString(), root, expectedCount: count, names, current,
      }) + "\n");
      process.exit(1);
    }
  ' "$root/.buck2/capabilities" "$count" "$TEMP_ROOT" || fail "generation set does not match selected defs or expected retained count"
  for version in "${versions[@]}"; do
    target="$(profile "$version")"
    gen="$(generation "$target")"
    directory="$root/.buck2/capabilities/generations/$gen"
    root_link="$root/.buck2/capability-roots/$gen"
    "$NIX_STORE_COMMAND" --query --roots "$target" >"$TEMP_ROOT/gc-roots"
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

# Simulate interruption after atomic prune detachment, at each metadata cleanup
# boundary, leaving partially deleted trees. Republishing that identity must
# install the complete immutable tree rather than diagnose immutable corruption.
prune_crash="$TEMP_ROOT/prune-crash"
mkdir -p "$prune_crash" "$(state_root "$prune_crash")/live"
printf '%s\n' "$$" >"$(state_root "$prune_crash")/live/buckd.pid"
for version in "${versions[@]}"; do
  publish "$prune_crash" "$version" >"$TEMP_ROOT/prune-crash-$version.json"
done
rm -rf "$(state_root "$prune_crash")"
mkdir -p "$prune_crash/.buck2/capability-trash"
for version in one two three; do
  detached_generation="$(generation "$(profile "$version")")"
  detached="$prune_crash/.buck2/capability-trash/$detached_generation.interrupted-$version"
  mv "$prune_crash/.buck2/capabilities/generations/$detached_generation" "$detached"
  rm -f "$detached/$PLATFORM/archive-tool/manifest.json"
  # Partial detached trees may contain read-only Nix metadata and directories.
  # Do not follow the per-tool links into the immutable Nix store.
  find "$detached" \( -type d -o -type f \) -exec chmod a-w {} +
  if [ "$version" != one ]; then
    rm "$prune_crash/.buck2/capability-roots/$detached_generation"
  fi
  if [ "$version" = three ]; then
    rm "$prune_crash/.buck2/capability-publications/$detached_generation.json"
  fi
done
publish "$prune_crash" one >"$TEMP_ROOT/prune-crash-recovery.json"
assert_result "$TEMP_ROOT/prune-crash-recovery.json" one 3 false
assert_retained "$prune_crash" 3
[ -f "$prune_crash/.buck2/capabilities/generations/$(generation "$(profile one)")/$PLATFORM/archive-tool/manifest.json" ] || fail "prune recovery did not restore the republished generation"
[ -z "$(find "$prune_crash/.buck2/capability-trash" -mindepth 1 -print -quit)" ] || fail "publication left interrupted prune trash"
for version in two three; do
  detached_generation="$(generation "$(profile "$version")")"
  [ ! -e "$prune_crash/.buck2/capability-publications/$detached_generation.json" ] || fail "prune recovery left an orphan receipt"
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
export REAL_NIX_STORE="$NIX_STORE_COMMAND" ROOTING_READY="$TEMP_ROOT/rooting-ready" ROOTING_RELEASE="$TEMP_ROOT/rooting-release"
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
  HOME="$TEST_HOME" "$BUN" "$ROOT/scripts/buck2-capability-publish.ts" --root "$concurrent" --profile "$(profile "$version")" --nix-store "$NIX_STORE_COMMAND" >"$TEMP_ROOT/concurrent-$version.json" &
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

jq -nc '{test:"publisher-contracts",concurrentPublishers:5,nativeFlock:true,crashReleasedLock:true,interruptedPruneRecovery:true,readOnlyPruneRecovery:true,liveRetainedCount:5,unknownStateDeferred:true,daemonFreeRetainedCount:3,migratedSymlink:true,registeredNixGCRoots:true,immutableCorruptionRejected:true}'
echo 'Buck capability publisher contracts passed.'
