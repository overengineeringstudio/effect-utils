#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -m)" != aarch64 ]; then
  echo "run-dev4.sh requires aarch64-linux" >&2
  exit 2
fi
if [ ! -f buck2/platforms/defs.bzl ] || [ ! -f flake.nix ]; then
  echo "run from the effect-utils repository root" >&2
  exit 2
fi

fixture="$PWD/context/buck2/.experiments/2026-09-19-nativelink-remote-execution"
state=/srv/bulk/coding-agents/tmp/nativelink
evidence=/tmp/nativelink-remote-execution-evidence
archive=/tmp/nativelink-remote-execution-evidence.tar.gz
source_input=packages/@overeng/content-address/src/mod.ts
native_pid=

rm -rf "$state" "$evidence" "$archive"
mkdir -p "$state" "$evidence"
exec > >(tee -a "$evidence/orchestrator.log") 2>&1

cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  if [ -n "$native_pid" ] && kill -0 "$native_pid" 2>/dev/null; then
    kill "$native_pid"
    wait "$native_pid"
  fi
  git restore buck2/dependencies/defs.bzl buck2/javascript.bzl buck2/materialization.bzl buck2/platforms/BUCK buck2/platforms/defs.bzl buck2/typescript.bzl "$source_input"
  rm -f .buckconfig.local .buck2/capabilities
  tar -C "$evidence" -czf "$archive" .
  rm -rf "$state"
  echo "evidence: $archive"
  exit "$status"
}
trap cleanup EXIT INT TERM

if ! git diff --quiet; then
  echo "tracked worktree changes present before experiment" >&2
  exit 2
fi
if ss -ltn | grep -Eq '127\.0\.0\.1:(51051|51061) '; then
  echo "NativeLink experiment port already occupied" >&2
  exit 2
fi

git apply --check "$fixture/remote-execution.patch"
git apply "$fixture/remote-execution.patch"
cp "$fixture/buckconfig.local" .buckconfig.local

nativelink_ref=${NATIVELINK_REF:-nixpkgs#nativelink}
if [ "$nativelink_ref" = nixpkgs#nativelink ] && ! nix eval --raw "$nativelink_ref.outPath" >/dev/null 2>&1; then
  nativelink_ref=github:TraceMachina/nativelink/a21edb0fc56879124e308bb9a67be679f8eaf885#nativelink
fi
printf 'NativeLink source: %s\n' "$nativelink_ref" | tee "$evidence/versions.txt"
nativelink_out=$(nix build --no-link --print-out-paths "$nativelink_ref")
buck2_out=$(nix build --no-link --print-out-paths .#buck2)
capabilities_out=$(nix build --no-link --print-out-paths .#buck2-capabilities)
nativelink_bin="$nativelink_out/bin/nativelink"
buck2_bin="$buck2_out/bin/buck2"
{
  "$nativelink_bin" --version || true
  "$buck2_bin" --version
  printf 'capabilities=%s\n' "$capabilities_out"
  nix path-info -r "$capabilities_out"
} | tee -a "$evidence/versions.txt"

mkdir -p .buck2
ln -s "$capabilities_out" .buck2/capabilities

RUST_LOG='info,nativelink_worker=debug,nativelink_scheduler=debug' \
  nohup "$nativelink_bin" "$fixture/nativelink.json5" \
  >"$evidence/nativelink.log" 2>&1 &
native_pid=$!
printf '%s\n' "$native_pid" >"$evidence/nativelink.pid"

ready=false
for _ in $(seq 1 60); do
  if ! kill -0 "$native_pid" 2>/dev/null; then
    echo "NativeLink exited during startup" >&2
    break
  fi
  if (exec 3<>/dev/tcp/127.0.0.1/51051) 2>/dev/null && (exec 3<>/dev/tcp/127.0.0.1/51061) 2>/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  cat "$evidence/nativelink.log"
  exit 1
fi

buck2() {
  "$buck2_bin" --isolation-dir=nativelink-re "$@"
}

fresh_buck_state() {
  buck2 kill >/dev/null 2>&1 || true
  rm -rf buck-out
}

run_buck() {
  label=$1
  shift
  start_ms=$(date +%s%3N)
  set +e
  buck2 "$@" >"$evidence/$label.stdout.log" 2>"$evidence/$label.stderr.log"
  status=$?
  set -e
  end_ms=$(date +%s%3N)
  elapsed_ms=$((end_ms - start_ms))
  set +e
  buck2 log what-ran >"$evidence/$label.what-ran.txt" 2>&1
  what_ran_status=$?
  set -e
  native_log_lines=$(wc -l <"$evidence/nativelink.log")
  printf '%s\t%s\t%s\t%s\t%s\n' "$label" "$elapsed_ms" "$status" "$what_ran_status" "$native_log_lines" | tee -a "$evidence/timings.tsv"
}

printf 'step\telapsed_ms\tcommand_status\twhat_ran_status\tnativelink_log_lines\n' >"$evidence/timings.tsv"

# Cold server state plus a cold Buck state proves execution rather than reuse.
fresh_buck_state
run_buck miss-typecheck build //packages/@overeng/content-address:typecheck
run_buck miss-emit build //packages/@overeng/content-address:dist
run_buck miss-test test //packages/@overeng/content-address:test
run_buck miss-quick build //:quick

# A declared source change creates new action keys while the NativeLink service stays warm.
printf '\n// nativelink remote-execution invalidation probe\n' >>"$source_input"
run_buck changed-typecheck build //packages/@overeng/content-address:typecheck
run_buck changed-emit build //packages/@overeng/content-address:dist
run_buck changed-test test //packages/@overeng/content-address:test

# Wipe Buck's local state but leave NativeLink intact; identical keys must be AC hits.
fresh_buck_state
run_buck unchanged-typecheck build //packages/@overeng/content-address:typecheck
run_buck unchanged-emit build //packages/@overeng/content-address:dist
run_buck unchanged-test test //packages/@overeng/content-address:test

# Keep concise machine-readable proof alongside the full logs.
grep -nE 'Worker registered with scheduler|Received request to run action|Executing command|Command complete|No candidate workers' \
  "$evidence/nativelink.log" >"$evidence/nativelink-execution-lines.txt" || true
grep -HnE 'tsgo_typecheck|tsgo_emit|vitest|Remote|Cache|remote|cache' \
  "$evidence"/*.what-ran.txt >"$evidence/what-ran-summary.txt" || true
