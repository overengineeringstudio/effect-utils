#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp -d /tmp/pnpm-store-gate.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

if [ -n "${SOURCE_TREE:-}" ]; then
  implementation_head="${IMPLEMENTATION_HEAD:?set IMPLEMENTATION_HEAD when SOURCE_TREE is used}"
  cp -R "$SOURCE_TREE" "$tmp/root-a"
  cp -R "$SOURCE_TREE" "$tmp/root-b"
  cp -R "$SOURCE_TREE" "$tmp/root-c"
else
  source_repo="${SOURCE_REPO:-$(git rev-parse --show-toplevel)}"
  implementation_head="${IMPLEMENTATION_HEAD:-$(git -C "$source_repo" rev-parse HEAD)}"
  git clone --quiet --no-checkout "$source_repo" "$tmp/repo"
  git -C "$tmp/repo" worktree add --quiet --detach "$tmp/root-a" "$implementation_head"
  git -C "$tmp/repo" worktree add --quiet --detach "$tmp/root-b" "$implementation_head"
  git -C "$tmp/repo" worktree add --quiet --detach "$tmp/root-c" "$implementation_head"
fi

pnpm_bin="${PNPM_BIN:-$(command -v pnpm)}"
node_bin="$(command -v node)"
store="$tmp/store"
mkdir -p "$store"

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
  printf 'TREE label=%s physical_kib=%s apparent_kib=%s files=%s\n' "$label" "$physical_kib" "$apparent_kib" "$files"
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
    printf 'PHASE name=%s teardown_rc=134 completed_materialization=true\n' "$phase"
    rc=0
  fi
  if [ "$rc" -ne 0 ]; then
    printf 'PHASE name=%s status=failed rc=%s\n' "$phase" "$rc"
    tail -n 100 "$tmp/$phase.log"
    return "$rc"
  fi
  end="$(now_ms)"
  printf 'PHASE name=%s duration_ms=%s\n' "$phase" "$((end - start))"
  tail -n 8 "$tmp/$phase.log"
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
  printf 'COMBINED label=%s physical_kib=%s apparent_kib=%s files=%s\n' "$label" "$physical_kib" "$apparent_kib" "$files"
}

printf 'PROVENANCE head=%s os=%s arch=%s filesystem=%s pnpm=%s node=%s\n' \
  "$implementation_head" "$(uname -s)" "$(uname -m)" "$(if [ "$(uname -s)" = Darwin ]; then printf apfs; else stat -f -c %T "$tmp"; fi)" "$("$pnpm_bin" --version)" "$("$node_bin" --version)"

install_root cold-root-a "$tmp/root-a" "$store"
install_root second-root-b "$tmp/root-b" "$store"
measure_combined shared-two-roots "$store" "$tmp/root-a/node_modules" "$tmp/root-b/node_modules"
install_root warm-root-b "$tmp/root-b" "$store"
install_root isolated-root-c "$tmp/root-c" "$tmp/isolated-store"
measure_combined isolated-one-root "$tmp/isolated-store" "$tmp/root-c/node_modules"

test -d "$tmp/root-a/node_modules/.pnpm"
test -d "$tmp/root-b/node_modules/.pnpm"
test "$(cd "$tmp/root-a/packages/@overeng/utils" && "$node_bin" -p "require.resolve('effect')")" != \
  "$(cd "$tmp/root-b/packages/@overeng/utils" && "$node_bin" -p "require.resolve('effect')")"

printf 'VIRTUAL_STORES distinct=true\n'
printf 'LIFECYCLE ignore_scripts=true\n'
