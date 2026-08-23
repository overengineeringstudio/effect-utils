#!/usr/bin/env bash
set -euo pipefail

tests_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${DEVENV_ROOT:-$(cd "$tests_dir/../../../../.." && pwd)}"
target_dir_script="$tests_dir/../cargo-target-dir.sh"
tmpdir="$(mktemp -d)"
writer_pid=""
trap 'test -z "$writer_pid" || kill "$writer_pid" 2>/dev/null || true; rm -rf "$tmpdir"' EXIT

workspace_a="$tmpdir/checkouts/a"
workspace_b="$tmpdir/checkouts/b"
cache_root="$tmpdir/cache"
mkdir -p "$workspace_a/source" "$workspace_b" "$cache_root"
printf 'fixture\n' > "$workspace_a/source/input.txt"

grep -qF 'export CARGO_TARGET_DIR="$(${./nix/devenv-modules/tasks/shared/cargo-target-dir.sh}' \
  "$root/devenv.nix" || {
  echo "FAIL: cargo:check does not use the isolated target-directory helper" >&2
  exit 1
}

target_a="$($target_dir_script "$workspace_a" cargo-check "$cache_root")"
target_a_again="$($target_dir_script "$workspace_a" cargo-check "$cache_root")"
target_b="$($target_dir_script "$workspace_b" cargo-check "$cache_root")"
target_other_task="$($target_dir_script "$workspace_a" cargo-test "$cache_root")"

test "$target_a" = "$target_a_again"
test "$target_a" != "$target_b"
test "$target_a" != "$target_other_task"
case "$target_a/" in
  "$workspace_a"/*)
    echo "FAIL: cargo target directory is inside the checkout" >&2
    exit 1
    ;;
esac

mkdir -p "$target_a/release/deps"
(
  while true; do
    temp_file="$target_a/release/deps/rmeta-concurrent"
    : > "$temp_file"
    rm -f "$temp_file"
  done
) &
writer_pid=$!

for _ in 1 2 3 4 5; do
  snapshot="$(nix eval --raw --impure --expr \
    "toString (builtins.path { path = $workspace_a; name = \"cargo-target-isolation-snapshot-$_\"; })")"
  test -f "$snapshot/source/input.txt"
  test ! -e "$snapshot/target"
done

kill "$writer_pid"
wait "$writer_pid" 2>/dev/null || true
writer_pid=""

if $target_dir_script "$workspace_a" cargo-check "$workspace_a/.cache" >/dev/null 2>&1; then
  echo "FAIL: workspace-contained cache root was accepted" >&2
  exit 1
fi

echo "cargo target isolation test passed"
