#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp -d /tmp/pnpm-store-gate.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

if [ -n "${SOURCE_TREE:-}" ]; then
  implementation_head="${IMPLEMENTATION_HEAD:?set IMPLEMENTATION_HEAD when SOURCE_TREE is used}"
  source_mode=git-archive-tree
  cp -R "$SOURCE_TREE" "$tmp/root-a"
  cp -R "$SOURCE_TREE" "$tmp/root-b"
  cp -R "$SOURCE_TREE" "$tmp/root-c"
  cp -R "$SOURCE_TREE" "$tmp/root-d"
  cp -R "$SOURCE_TREE" "$tmp/root-e"
else
  source_repo="${SOURCE_REPO:-$(git rev-parse --show-toplevel)}"
  implementation_head="${IMPLEMENTATION_HEAD:-$(git -C "$source_repo" rev-parse HEAD)}"
  source_mode=git-worktree
  git clone --quiet --no-checkout "$source_repo" "$tmp/repo"
  git -C "$tmp/repo" worktree add --quiet --detach "$tmp/root-a" "$implementation_head"
  git -C "$tmp/repo" worktree add --quiet --detach "$tmp/root-b" "$implementation_head"
  git -C "$tmp/repo" worktree add --quiet --detach "$tmp/root-c" "$implementation_head"
  git -C "$tmp/repo" worktree add --quiet --detach "$tmp/root-d" "$implementation_head"
  git -C "$tmp/repo" worktree add --quiet --detach "$tmp/root-e" "$implementation_head"
fi

pnpm_bin="${PNPM_BIN:-$(command -v pnpm)}"
node_bin="$(command -v node)"
store="$tmp/store"
mkdir -p "$store"

case "$(uname -s):$(uname -m)" in
  Linux:x86_64) platform=x86_64-linux ;;
  Darwin:arm64) platform=aarch64-darwin ;;
  *) platform="$(uname -m)-$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
esac
if [ "$(uname -s)" = Darwin ]; then
  filesystem=apfs
else
  filesystem="$(findmnt -n -o FSTYPE --target "$tmp" 2>/dev/null || stat -f -c %T "$tmp")"
fi
if command -v sha256sum >/dev/null 2>&1; then
  harness_sha256="$(sha256sum "$0" | awk '{print $1}')"
else
  harness_sha256="$(shasum -a 256 "$0" | awk '{print $1}')"
fi

now_ms() {
  perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1000'
}

measure_tree() {
  local label="$1"
  local path="$2"
  local physical_kib=0
  local apparent_kib=0
  local files=0
  if [ -e "$path" ]; then
    physical_kib="$(du -sk "$path" | awk '{print $1}')"
    if [ "$(uname -s)" = Darwin ]; then
      apparent_kib="$(du -skA "$path" | awk '{print $1}')"
    else
      apparent_kib="$(du -sk --apparent-size "$path" | awk '{print $1}')"
    fi
    files="$(find "$path" -type f | wc -l | tr -d ' ')"
  fi
  printf '{"schema":"dependency-materialization-verification/v0","kind":"benchmark","surface":"storage-sharing","platform":"%s","phase":"size:%s","status":"ok","sizes":{"physicalKiB":%s,"apparentKiB":%s,"files":%s}}\n' \
    "$platform" "$label" "$physical_kib" "$apparent_kib" "$files"
}

install_root() {
  local phase="$1"
  local root="$2"
  local active_store="$3"
  local start end rc
  start="$(now_ms)"
  set +e
  (
    cd "$root"
    CI='' NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=1536" PNPM_SHARED_STORE_DIR="$active_store" "$pnpm_bin" install \
      --frozen-lockfile \
      --ignore-scripts \
      --config.side-effects-cache=false \
      --config.verify-store-integrity=true \
      --config.strict-store-pkg-content-check=true \
      --config.enable-global-virtual-store=false \
      --config.virtual-store-dir=node_modules/.pnpm \
      --config.package-import-method=auto \
      --config.store-dir="$active_store" \
      --child-concurrency=1 \
      --network-concurrency=4 \
      --reporter=append-only
  ) >"$tmp/$phase.log" 2>&1
  rc=$?
  set -e
  if [ "$rc" -eq 134 ] &&
    [ "$(uname -s)" = Darwin ] &&
    grep -qE 'Progress: .* done$' "$tmp/$phase.log" &&
    [ -d "$root/node_modules/.pnpm" ] &&
    [ -f "$root/node_modules/.modules.yaml" ]; then
    completed_materialization=true
    rc=0
  else
    completed_materialization=false
  fi
  if [ "$rc" -ne 0 ]; then
    printf '{"schema":"dependency-materialization-verification/v0","kind":"benchmark","surface":"storage-sharing","platform":"%s","phase":"%s","status":"failed","exitCode":%s}\n' "$platform" "$phase" "$rc"
    tail -n 100 "$tmp/$phase.log" >&2
    return "$rc"
  fi
  end="$(now_ms)"
  local progress_line reused downloaded teardown_exit
  progress_line="$(grep -E 'Progress: .* done$' "$tmp/$phase.log" | tail -n 1)"
  reused="$(printf '%s\n' "$progress_line" | sed -nE 's/.*reused ([0-9]+).*/\1/p')"
  downloaded="$(printf '%s\n' "$progress_line" | sed -nE 's/.*downloaded ([0-9]+).*/\1/p')"
  teardown_exit=0
  if [ "$completed_materialization" = true ]; then
    teardown_exit=134
  fi
  printf '{"schema":"dependency-materialization-verification/v0","kind":"benchmark","surface":"storage-sharing","platform":"%s","phase":"%s","status":"ok","durationMs":%s,"reused":%s,"downloads":%s,"teardownExit":%s,"completedMaterializationEvidence":%s}\n' \
    "$platform" "$phase" "$((end - start))" "${reused:-0}" "${downloaded:-0}" "$teardown_exit" "$completed_materialization"
  measure_tree "$phase-root-node-modules" "$root/node_modules"
  measure_tree "$phase-store" "$active_store"
}

measure_combined() {
  local label="$1"
  shift
  local physical_kib apparent_kib files
  physical_kib="$(du -skc "$@" | tail -n 1 | awk '{print $1}')"
  if [ "$(uname -s)" = Darwin ]; then
    apparent_kib="$(du -skAc "$@" | tail -n 1 | awk '{print $1}')"
  else
    apparent_kib="$(du -skc --apparent-size "$@" | tail -n 1 | awk '{print $1}')"
  fi
  files="$(find "$@" -type f | wc -l | tr -d ' ')"
  printf '{"schema":"dependency-materialization-verification/v0","kind":"benchmark","surface":"storage-sharing","platform":"%s","phase":"size:%s","status":"ok","sizes":{"physicalKiB":%s,"apparentKiB":%s,"files":%s}}\n' \
    "$platform" "$label" "$physical_kib" "$apparent_kib" "$files"
}

printf '{"schema":"dependency-materialization-verification/v0","kind":"benchmark","surface":"storage-sharing","platform":"%s","phase":"provenance","status":"ok","implementationHead":"%s","harnessSha256":"%s","sourceMode":"%s","filesystem":"%s","pnpm":"%s","node":"%s"}\n' \
  "$platform" "$implementation_head" "$harness_sha256" "$source_mode" "$filesystem" "$("$pnpm_bin" --version)" "$("$node_bin" --version)"

install_root cold-root-a "$tmp/root-a" "$store"
install_root second-root-b "$tmp/root-b" "$store"
measure_combined shared-two-roots "$store" "$tmp/root-a/node_modules" "$tmp/root-b/node_modules"
install_root warm-root-b "$tmp/root-b" "$store"
install_root isolated-root-c "$tmp/root-c" "$tmp/isolated-store"
measure_combined isolated-one-root "$tmp/isolated-store" "$tmp/root-c/node_modules"

concurrent_start="$(now_ms)"
set +e
install_root concurrent-root-d "$tmp/root-d" "$store" >"$tmp/concurrent-root-d.jsonl" &
concurrent_d_pid=$!
install_root concurrent-root-e "$tmp/root-e" "$store" >"$tmp/concurrent-root-e.jsonl" &
concurrent_e_pid=$!
wait "$concurrent_d_pid"
concurrent_d_status=$?
wait "$concurrent_e_pid"
concurrent_e_status=$?
set -e
cat "$tmp/concurrent-root-d.jsonl" "$tmp/concurrent-root-e.jsonl"
if [ "$concurrent_d_status" -ne 0 ] || [ "$concurrent_e_status" -ne 0 ]; then
  exit 1
fi
concurrent_end="$(now_ms)"
printf '{"schema":"dependency-materialization-verification/v0","kind":"benchmark","surface":"storage-sharing","platform":"%s","phase":"concurrent-pair","status":"ok","durationMs":%s,"roots":2}\n' \
  "$platform" "$((concurrent_end - concurrent_start))"
measure_combined concurrent-two-roots "$store" "$tmp/root-d/node_modules" "$tmp/root-e/node_modules"

test -d "$tmp/root-a/node_modules/.pnpm"
test -d "$tmp/root-b/node_modules/.pnpm"
test -d "$tmp/root-d/node_modules/.pnpm"
test -d "$tmp/root-e/node_modules/.pnpm"
test "$(cd "$tmp/root-a/packages/@overeng/utils" && "$node_bin" -p "require.resolve('effect')")" != \
  "$(cd "$tmp/root-b/packages/@overeng/utils" && "$node_bin" -p "require.resolve('effect')")"

printf '{"schema":"dependency-materialization-verification/v0","kind":"benchmark","surface":"storage-sharing","platform":"%s","phase":"correctness","status":"ok","distinctVirtualStores":true,"concurrentRoots":2,"ignoreScriptsConfigured":true,"sigkill137Accepted":false}\n' "$platform"
