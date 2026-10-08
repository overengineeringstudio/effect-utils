#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd -P)"
FIXTURES="$TESTS_DIR/buck2-capability-fixture"
PUBLISHER=production
WATCHER=both
while [ "$#" -gt 0 ]; do
  case "$1" in
    --publisher) PUBLISHER="${2:?--publisher requires production or legacy}"; shift 2 ;;
    --watcher) WATCHER="${2:?--watcher requires notify, watchman, or both}"; shift 2 ;;
    *) echo "usage: $0 [--publisher production|legacy] [--watcher notify|watchman|both]" >&2; exit 2 ;;
  esac
done
case "$PUBLISHER" in production|legacy) ;; *) echo "invalid publisher: $PUBLISHER" >&2; exit 2 ;; esac
case "$WATCHER" in notify|watchman|both) ;; *) echo "invalid watcher: $WATCHER" >&2; exit 2 ;; esac
BUN="${BUN_BIN:-$(command -v bun)}"
BUCK2="${BUCK2_BIN:-$(command -v buck2)}"
NIX="${NIX_BIN:-$(command -v nix)}"
NIX_STORE_COMMAND="${NIX_STORE_BIN:-$(command -v nix-store)}"
for tool in jq tar env; do command -v "$tool" >/dev/null; done
WATCHMAN_COMMAND=""
if [ "$WATCHER" != notify ]; then WATCHMAN_COMMAND="$(command -v watchman)"; fi
TEMP_ROOT="$(mktemp -d)"
TEMP_ROOT="$(cd "$TEMP_ROOT" && pwd -P)"
TEST_HOME="$TEMP_ROOT/home"
mkdir -p "$TEST_HOME"
declare -a daemon_roots=() daemon_isolations=()
private_watchman_started=false
private_watchman_socket_dir=""
cleanup() {
  local exit_code=$? index
  for ((index=0; index<${#daemon_roots[@]}; index++)); do
    (cd "${daemon_roots[$index]}" && HOME="$TEST_HOME" "$BUCK2" --isolation-dir "${daemon_isolations[$index]}" kill) >/dev/null 2>&1 || true
  done
  if [ "$private_watchman_started" = true ]; then
    if ! HOME="$TEST_HOME" "$WATCHMAN_COMMAND" --sockname="$WATCHMAN_SOCK" --no-spawn --no-local shutdown-server \
      >"$TEMP_ROOT/watchman-shutdown.json" 2>"$TEMP_ROOT/watchman-shutdown.stderr"; then
      cat "$TEMP_ROOT/watchman-shutdown.stderr" >&2
      echo "FAIL: private Watchman shutdown failed" >&2
      exit_code=1
    elif ! jq -e '.["shutdown-server"] == true' "$TEMP_ROOT/watchman-shutdown.json" >/dev/null; then
      echo "FAIL: private Watchman did not acknowledge shutdown" >&2
      exit_code=1
    fi
  fi
  if [ -n "$private_watchman_socket_dir" ]; then rm -rf "$private_watchman_socket_dir"; fi
  chmod -R u+w "$TEMP_ROOT" 2>/dev/null || true
  rm -rf "$TEMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fail() { echo "FAIL: $*" >&2; exit 1; }

# Real pinned Nix packages and the production projection generator. No npm
# acquisition or repository graph/network cache is involved in this fixture.
export NIX_FLAKE_REF="${NIX_FLAKE_REF:-git+file://$ROOT?shallow=1}"
export CAPABILITY_FIXTURE_ROOT="$ROOT" CAPABILITY_FIXTURE_NIX="$FIXTURES/profiles.nix"
profiles_file="$("$NIX" build --impure --no-link --print-out-paths --expr '
  let
    flake = builtins.getFlake (builtins.getEnv "NIX_FLAKE_REF");
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in import (builtins.toPath (builtins.getEnv "CAPABILITY_FIXTURE_NIX")) {
    inherit pkgs;
    repoRoot = builtins.toPath (builtins.getEnv "CAPABILITY_FIXTURE_ROOT");
  }
')"
PROFILE_ONE="$(jq -er '.profiles.one' "$profiles_file")"
PROFILE_TWO="$(jq -er '.profiles.two' "$profiles_file")"
PLATFORM="$(jq -er '.platform' "$profiles_file")"
generation() { "$BUN" -e 'console.log(require("fs").readFileSync(process.argv[1], "utf8").match(/^GENERATION = "([0-9a-f]{64})"$/m)[1])' "$1/defs.bzl"; }
GEN_ONE="$(generation "$PROFILE_ONE")"
GEN_TWO="$(generation "$PROFILE_TWO")"
[ "$GEN_ONE" != "$GEN_TWO" ] || fail "fixture did not produce two genuine generations"

assert_store_input() {
  local cell="$1" gen="$2" tool target manifest expected
  for tool in archive-tool support-directory; do
    manifest="$cell/generations/$gen/$PLATFORM/$tool/manifest.json"
    if [ "$tool" = archive-tool ]; then
      expected="$(jq -er '.executableStorePath' "$manifest")"
      target="$(readlink "$cell/generations/$gen/$PLATFORM/$tool/executable")"
    else
      expected="$(jq -er '.directoryStorePath' "$manifest")"
      target="$(readlink "$cell/generations/$gen/$PLATFORM/$tool/directory")"
    fi
    [ "$target" = "$expected" ] || fail "$tool input does not point directly to its declared store path"
    case "$target" in /nix/store/*) ;; *) fail "$tool input is not a Nix store path: $target" ;; esac
    case "$target" in *buck2-capabilities*) fail "$tool input incorrectly goes through aggregate projection: $target" ;; esac
    jq -nc --arg tool "$tool" --arg generation "$gen" --arg target "$target" '{evidence:"direct-store-input",tool:$tool,generation:$generation,target:$target}'
  done
}
assert_gc_root() {
  local root="$1" gen="$2" profile="$3" gc_root
  gc_root="$root/.buck2/capability-roots/$gen"
  [ -L "$gc_root" ] || fail "missing generation GC root $gen"
  [ "$(readlink "$gc_root")" = "$profile" ] || fail "generation GC root targets wrong profile"
  "$NIX_STORE_COMMAND" --query --roots "$profile" >"$TEMP_ROOT/gc-roots"
  grep -Fq -- "$gc_root" "$TEMP_ROOT/gc-roots" || fail "Nix did not register indirect generation root $gen"
}

if [ "$WATCHER" = both ]; then watchers=(notify watchman); else watchers=("$WATCHER"); fi
legacy_failures=0
for watcher in "${watchers[@]}"; do
  fixture="$TEMP_ROOT/$watcher"
  isolation="capability-regression-$watcher"
  mkdir -p "$fixture/.buck2"
  cp "$FIXTURES/BUCK" "$FIXTURES/configured.bzl" "$FIXTURES/rules.bzl" "$fixture/"
  touch "$fixture/.buckroot"
  cat >"$fixture/.buckconfig" <<CONFIG
[cells]
  root = .
  capabilities = .buck2/capabilities
  prelude = prelude
[cell_aliases]
  config = prelude
  ovr_config = prelude
  fbsource = prelude
  toolchains = root
[external_cells]
  prelude = bundled
[parser]
  target_platform_detector_spec = target:root//...->prelude//platforms:default target:capabilities//...->prelude//platforms:default
[build]
  execution_platforms = prelude//platforms:default
[buck2]
  file_watcher = $watcher
  remote_cache_enabled = false
  allow_cache_uploads = false
  digest_algorithms = SHA256
[fixture]
  platform = $PLATFORM
[project]
  ignore = buck-out
CONFIG
  printf '{"ignore_dirs":["buck-out"]}\n' >"$fixture/.watchmanconfig"
  if [ "$watcher" = watchman ]; then
    # Native CLI spawning performs the readiness handshake for this private
    # socket; it cannot use launchd/systemd or a host-owned Watchman service.
    # Darwin Unix sockets have a 104-byte sun_path; inherited TMPDIR is unbounded.
    private_watchman_socket_dir="$(mktemp -d /tmp/bw.XXXXXX)"
    chmod 0700 "$private_watchman_socket_dir"
    export WATCHMAN_SOCK="$private_watchman_socket_dir/w.sock"
    [ "${#WATCHMAN_SOCK}" -lt 100 ] || fail "private Watchman socket path must be shorter than 100 bytes for Darwin: $WATCHMAN_SOCK"
    # Watchman's global config, not .watchmanconfig, controls startup priority.
    # Keep this relaxation private and isolate HOME's overriding .watchman.json.
    export WATCHMAN_CONFIG_FILE="$TEMP_ROOT/w.config"
    printf '{"min_acceptable_nice_value":19}\n' >"$WATCHMAN_CONFIG_FILE"
    private_watchman_started=true
    # Assert the fixture relaxation under an explicitly raised priority, not
    # just whatever priority the test runner happens to inherit.
    HOME="$TEST_HOME" nice -n 19 "$WATCHMAN_COMMAND" --no-site-spawner --sockname="$WATCHMAN_SOCK" \
      --statefile="$TEMP_ROOT/w.state" --logfile="$TEMP_ROOT/w.log" \
      --pidfile="$TEMP_ROOT/w.pid" --no-local version >"$TEMP_ROOT/watchman-version.json"
    jq -e '.version | type == "string" and length > 0' "$TEMP_ROOT/watchman-version.json" >/dev/null \
      || fail "private Watchman did not become ready at nice 19"
    HOME="$TEST_HOME" "$WATCHMAN_COMMAND" --sockname="$WATCHMAN_SOCK" --no-spawn --no-local get-pid \
      >"$TEMP_ROOT/watchman-pid.json"
    jq -e '.pid | type == "number" and . > 0' "$TEMP_ROOT/watchman-pid.json" >/dev/null \
      || fail "private Watchman did not report its service PID"
    service_nice="$(ps -o nice= -p "$(jq -r '.pid' "$TEMP_ROOT/watchman-pid.json")" 2>/dev/null | tr -d '[:space:]')"
    [ "$service_nice" -ge 1 ] 2>/dev/null \
      || fail "private Watchman is not serving at a raised nice value (reported: '${service_nice}')"
    jq -nc --arg socket "$WATCHMAN_SOCK" --slurpfile service "$TEMP_ROOT/watchman-pid.json" --arg nice "$service_nice" \
      '{evidence:"private-watchman",socket:$socket,pid:$service[0].pid,nice:$nice}'
  fi
  # Start against the old deployment layout. The production scenario must
  # migrate this live cell, not merely rotate an already-real directory.
  ln -s "$PROFILE_ONE" "$fixture/.buck2/capabilities"
  assert_store_input "$fixture/.buck2/capabilities" "$GEN_ONE"
  daemon_roots+=("$fixture")
  daemon_isolations+=("$isolation")
  buck() { (cd "$fixture" && HOME="$TEST_HOME" "$BUCK2" --isolation-dir "$isolation" "$@"); }
  write_archive() {
    mkdir -p "$TEMP_ROOT/archive-$watcher/package"
    printf '%s\n' "$1" >"$TEMP_ROOT/archive-$watcher/package/payload.txt"
    tar -cf "$fixture/package.tar" -C "$TEMP_ROOT/archive-$watcher" package
  }
  build_extract() {
    buck build root//:pnpm_extract --show-json-output --write-build-id "$fixture/$1.trace" >"$fixture/$1.output" 2>"$fixture/$1.stderr"
  }
  capture_log() { buck log show --trace-id "$(cat "$fixture/$1.trace")" >"$fixture/$1.events"; }
  assert_native_log() {
    local phase="$1" expected_provider
    if [ "$watcher" = watchman ]; then expected_provider=0; else expected_provider=1; fi
    jq -es --argjson provider "$expected_provider" --arg uuid "$daemon_uuid" '
      any(.[]; .Event.data.SpanStart.data.FileWatcher.provider? == $provider) and
      any(.[]; .Event.data.SpanStart.data.Command.metadata.daemon_uuid? == $uuid) and
      any(.[]; .Event.data.SpanStart.data.ActionExecution.name.category? == "pnpm_extract")
    ' "$fixture/$phase.events" >/dev/null || fail "$watcher/$phase native log does not prove requested watcher, same daemon, and extraction action"
  }
  assert_output() {
    local phase="$1" version="$2" payload="$3" output selected_profile selected_gen manifest
    output="$(jq -er 'to_entries | map(.value) | .[0]' "$fixture/$phase.output")"
    case "$output" in /*) ;; *) output="$fixture/$output" ;; esac
    [ "$(cat "$output/capability-version.txt")" = "$version" ] || fail "$watcher/$phase used stale executable capability"
    [ "$(cat "$output/payload.txt")" = "$payload" ] || fail "$watcher/$phase did not rerun extraction"
    [ "$(cat "$output/support.txt")" = 'immutable directory input' ] || fail "$watcher/$phase lost directory input"
    if [ "$version" = one ]; then selected_profile="$PROFILE_ONE"; selected_gen="$GEN_ONE"; else selected_profile="$PROFILE_TWO"; selected_gen="$GEN_TWO"; fi
    manifest="$selected_profile/generations/$selected_gen/$PLATFORM/archive-tool/manifest.json"
    [ "$(cat "$output/executable-store-path.txt")" = "$(jq -er '.executableStorePath' "$manifest")" ] || fail "$watcher/$phase consumed stale executable manifest"
    [ "$(cat "$output/closure-identity.txt")" = "$(jq -er '.closureIdentity' "$manifest")" ] || fail "$watcher/$phase consumed stale tool closure identity"
    case "$(cat "$output/executable-store-path.txt")" in *buck2-capabilities*) fail "action consumed aggregate projection path" ;; esac
  }
  assert_materialized_input() {
    local phase="$1" selected_gen="$2" argv executable action_manifest expected target source_manifest
    argv="$(jq -es '
      [.[] | .Event.data.SpanStart.data.ExecutorStage.stage.Local.stage.Execute.command.argv? // empty |
        select(.[1] == "--capability-manifest" and .[3] == "extract-npm")] |
      if length == 1 then .[0] else error("expected exactly one native extraction command") end
    ' "$fixture/$phase.events")" || fail "$watcher/$phase did not expose native extraction argv"
    executable="$(jq -er '.[0]' <<<"$argv")"
    action_manifest="$(jq -er '.[2]' <<<"$argv")"
    case "$executable" in /*) ;; *) executable="$fixture/$executable" ;; esac
    case "$action_manifest" in /*) ;; *) action_manifest="$fixture/$action_manifest" ;; esac
    source_manifest="$fixture/.buck2/capabilities/generations/$selected_gen/$PLATFORM/archive-tool/manifest.json"
    expected="$(jq -er '.executableStorePath' "$source_manifest")"
    [ -L "$executable" ] || fail "$watcher/$phase materialized executable is not a preserved input symlink"
    target="$(readlink "$executable")"
    [ "$target" = "$expected" ] || fail "$watcher/$phase materialized executable does not point directly to its per-tool store path: $target"
    case "$target" in /nix/store/*buck2-capabilities*) fail "$watcher/$phase materialized executable still goes through aggregate profile" ;; /nix/store/*) ;; *) fail "$watcher/$phase materialized executable is not a direct Nix store link" ;; esac
    [ -f "$action_manifest" ] && [ ! -L "$action_manifest" ] || fail "$watcher/$phase manifest was not materialized as a real copied artifact"
    cmp -s "$source_manifest" "$action_manifest" || fail "$watcher/$phase materialized manifest does not match selected generation"
    jq -nc --arg watcher "$watcher" --arg phase "$phase" --arg executable "$executable" --arg target "$target" --arg manifest "$action_manifest" \
      '{evidence:"materialized-action-input",watcher:$watcher,phase:$phase,executable:$executable,target:$target,manifest:$manifest}'
  }
  write_archive before
  build_extract before || { cat "$fixture/before.stderr" >&2; fail "$watcher initial extraction failed"; }
  capture_log before
  buck status >"$fixture/before.status"
  daemon_uuid="$(jq -er '.daemon_constraints.daemon_id | select(length > 0)' "$fixture/before.status")"
  assert_native_log before
  assert_output before one before
  if [ "$PUBLISHER" != legacy ]; then
    alternate_isolation="$isolation-alternate"
    daemon_roots+=("$fixture")
    daemon_isolations+=("$alternate_isolation")
    (cd "$fixture" && HOME="$TEST_HOME" "$BUCK2" --isolation-dir "$alternate_isolation" targets root//:pnpm_extract) \
      >"$fixture/alternate.targets" 2>"$fixture/alternate.stderr"
  fi

  if [ "$PUBLISHER" = legacy ]; then
    # GNU -T was the old publisher. BSD ln's -h gives the same no-dereference
    # replacement when the regression is run on Darwin.
    if [ "$(uname -s)" = Darwin ]; then
      ln -sfnh "$PROFILE_TWO" "$fixture/.buck2/capabilities"
    else
      ln -sfnT "$PROFILE_TWO" "$fixture/.buck2/capabilities"
    fi
  else
    # A failed native lifecycle command must leave a retryable obligation,
    # even though the fully populated real root is already visible.
    migration_failure=0
    HOME="$TEST_HOME" "$BUN" "$ROOT/scripts/buck2-capability-publish.ts" --root "$fixture" --profile "$PROFILE_TWO" --nix-store "$NIX_STORE_COMMAND" --buck2 "$fixture/missing-buck2" \
      >"$fixture/failed-publication.json" 2>"$fixture/failed-publication.stderr" || migration_failure=$?
    [ "$migration_failure" -ne 0 ] && [ -f "$fixture/.buck2/capabilities.migration" ] || fail "failed migration did not preserve its lifecycle obligation"
    [ ! -L "$fixture/.buck2/capabilities" ] || fail "native stop failure occurred before the complete real root was installed"
    HOME="$TEST_HOME" "$BUN" "$ROOT/scripts/buck2-capability-publish.ts" --root "$fixture" --profile "$PROFILE_TWO" --nix-store "$NIX_STORE_COMMAND" --buck2 "$BUCK2" >"$fixture/publication.json"
    jq -e --arg gen "$GEN_TWO" --arg primary "$fixture:$isolation" --arg alternate "$fixture:$alternate_isolation" '
      .generation == $gen and .retainedCount == 2 and
      (.migrationDaemonStops | sort) == ([$primary, $alternate] | sort)
    ' "$fixture/publication.json" >/dev/null || fail "migration did not retain both generations and stop only its two registered isolations"
    [ ! -e "$fixture/.buck2/capabilities.migration" ] || fail "successful native migration stop did not clear its obligation"
    [ -d "$fixture/.buck2/capabilities" ] && [ ! -L "$fixture/.buck2/capabilities" ] || fail "publisher did not migrate to a stable real capability cell"
    assert_gc_root "$fixture" "$GEN_ONE" "$PROFILE_ONE"
    assert_gc_root "$fixture" "$GEN_TWO" "$PROFILE_TWO"
    assert_store_input "$fixture/.buck2/capabilities" "$GEN_ONE"
  fi
  assert_store_input "$fixture/.buck2/capabilities" "$GEN_TWO"
  write_archive after
  after_exit=0
  build_extract after || after_exit=$?
  capture_log after
  buck status >"$fixture/after.status"
  after_uuid="$(jq -er '.daemon_constraints.daemon_id' "$fixture/after.status")"
  if [ "$PUBLISHER" = legacy ]; then
    [ "$after_uuid" = "$daemon_uuid" ] || fail "$watcher legacy rotation unexpectedly restarted the daemon"
  else
    [ "$after_uuid" != "$daemon_uuid" ] || fail "$watcher structural migration did not replace the old-watch-topology daemon"
    migrated_uuid="$daemon_uuid"
    daemon_uuid="$after_uuid"
  fi
  assert_native_log after
  if [ "$PUBLISHER" = legacy ]; then
    [ "$after_exit" -ne 0 ] || fail "$watcher legacy counterexample unexpectedly passed"
    grep -Fq -- "$GEN_ONE" "$fixture/after.events" || fail "legacy failure did not reference old generation"
    grep -Eq 'Failed to spawn a process|No such file or directory|ENOENT' "$fixture/after.stderr" "$fixture/after.events" || fail "legacy failure was not the stale executable spawn failure"
    materialized="$(jq -r '.Event.data.SpanStart.data.ExecutorStage.stage.Local.stage.Execute.command.argv[0]? // empty' "$fixture/after.events" | grep -F "/$GEN_ONE/" | grep '/executable$')"
    [ -n "$materialized" ] || fail "legacy log did not expose old-generation executable input"
    enoent_exit=0
    (cd "$fixture" && env "$materialized") >"$fixture/enoent.stdout" 2>"$fixture/enoent.stderr" || enoent_exit=$?
    [ "$enoent_exit" = 127 ] || fail "old-generation executable did not fail with native env ENOENT"
    grep -Eq 'No such file or directory|ENOENT' "$fixture/enoent.stderr" || fail "native executable evidence was not ENOENT"
    jq -nc --arg watcher "$watcher" --arg uuid "$daemon_uuid" --arg generation "$GEN_ONE" --arg executable "$materialized" --argjson exit "$after_exit" '{publisher:"legacy",watcher:$watcher,daemonUUID:$uuid,staleGeneration:$generation,executable:$executable,rotationExit:$exit,enoentExit:127}'
    legacy_failures=$((legacy_failures + 1))
  else
    [ "$after_exit" = 0 ] || { cat "$fixture/after.stderr" >&2; fail "$watcher migrated rotation failed"; }
    assert_output after two after
    assert_materialized_input after "$GEN_TWO"
    # Subsequent real-root publications must invalidate definitions while
    # preserving this daemon; the structural lifecycle boundary is one-time.
    HOME="$TEST_HOME" "$BUN" "$ROOT/scripts/buck2-capability-publish.ts" --root "$fixture" --profile "$PROFILE_ONE" --nix-store "$NIX_STORE_COMMAND" --buck2 "$BUCK2" >"$fixture/steady-publication.json"
    jq -e --arg gen "$GEN_ONE" '.generation == $gen and .retainedCount == 2 and .pruningDeferred == true and .migrationDaemonStops == []' "$fixture/steady-publication.json" >/dev/null
    write_archive steady
    build_extract steady || { cat "$fixture/steady.stderr" >&2; fail "$watcher steady real-cell rotation failed"; }
    capture_log steady
    buck status >"$fixture/steady.status"
    [ "$(jq -er '.daemon_constraints.daemon_id' "$fixture/steady.status")" = "$daemon_uuid" ] || fail "$watcher steady publication restarted daemon"
    assert_native_log steady
    assert_output steady one steady
    assert_materialized_input steady "$GEN_ONE"
    grep -Fq -- 'capabilities//defs.bzl' "$fixture/steady.events" || fail "$watcher steady rotation did not report watched defs.bzl change"
    assert_gc_root "$fixture" "$GEN_ONE" "$PROFILE_ONE"
    assert_gc_root "$fixture" "$GEN_TWO" "$PROFILE_TWO"
    jq -nc --arg watcher "$watcher" --arg oldUUID "$migrated_uuid" --arg uuid "$daemon_uuid" --arg before "$GEN_ONE" --arg after "$GEN_TWO" '{publisher:"production",watcher:$watcher,migratedDaemonUUID:$oldUUID,daemonUUID:$uuid,beforeGeneration:$before,afterGeneration:$after,migrationExit:0,steadyRotationExit:0,retainedCount:2,pruningDeferred:true,migrationDaemonStops:2,steadyDaemonStops:0}'
  fi
done
if [ "$PUBLISHER" = legacy ]; then
  echo "FAIL: legacy publisher reproduced stale-generation ENOENT for $legacy_failures watcher(s)" >&2
  exit 1
fi
echo 'Buck capability long-lived daemon regression passed (migration and real-cell rotation).'
