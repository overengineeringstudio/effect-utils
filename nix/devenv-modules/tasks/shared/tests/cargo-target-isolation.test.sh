#!/usr/bin/env bash
set -euo pipefail

tests_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${DEVENV_ROOT:-$(cd "$tests_dir/../../../../.." && pwd)}"
target_dir_script="$tests_dir/../cargo-target-dir.sh"
check_crate_script="$tests_dir/../cargo-check-crate.sh"
tmpdir="$(mktemp -d)"
writer_pid=""
trap 'test -z "$writer_pid" || kill "$writer_pid" 2>/dev/null || true; rm -rf "$tmpdir"' EXIT

workspace_a="$tmpdir/checkouts/a"
workspace_b="$tmpdir/checkouts/b"
cache_root="$tmpdir/cache"
mkdir -p "$workspace_a/source" "$workspace_b" "$cache_root"
printf 'fixture\n' > "$workspace_a/source/input.txt"

fake_bin="$tmpdir/bin"
fixture_root="$tmpdir/cargo-root"
task_cache_root="$tmpdir/task-cache"
mkdir -p \
  "$fake_bin" \
  "$fixture_root/packages/@overeng/otelite" \
  "$fixture_root/packages/@overeng/otel-scrape" \
  "$task_cache_root"
printf '[package]\nname = "otelite"\nversion = "0.0.0"\n' \
  > "$fixture_root/packages/@overeng/otelite/Cargo.toml"
printf '[package]\nname = "otel-scrape"\nversion = "0.0.0"\n' \
  > "$fixture_root/packages/@overeng/otel-scrape/Cargo.toml"
cat > "$fake_bin/cargo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
test -f Cargo.toml
printf '%s\t%s\t%s\n' "$PWD" "$CARGO_TARGET_DIR" "$*" >> "$CARGO_CALLS"
SH
chmod +x "$fake_bin/cargo"

nix-instantiate --eval --strict --json --expr "
  let
    root = $root;
    flake = builtins.getFlake (toString root);
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    module = import (root + /devenv.nix) {
      inherit pkgs;
      inputs = flake.inputs;
      config = { devenv.root = \"$fixture_root\"; };
      lib = pkgs.lib;
    };
  in module.tasks.\"cargo:check\".exec
" | jq -r . > "$tmpdir/cargo-check-task"
chmod +x "$tmpdir/cargo-check-task"
perl -0pi -e '
  s#/nix/store/[^"\s]*-cargo-target-dir[.]sh#'"$target_dir_script"'#g;
  s#/nix/store/[^"\s]*-cargo-check-crate[.]sh#'"$check_crate_script"'#g;
' "$tmpdir/cargo-check-task"

(
  cd /tmp
  PATH="$fake_bin:$PATH" \
    CARGO_CALLS="$tmpdir/cargo-calls" \
    XDG_CACHE_HOME="$task_cache_root" \
    OTEL_SPAN_BIN="$tmpdir/missing-otel-span" \
    "$tmpdir/cargo-check-task"
)

expected_target="$($target_dir_script "$fixture_root" cargo-check "$task_cache_root")"
test "$(wc -l < "$tmpdir/cargo-calls")" -eq 8
awk -F '\t' -v root="$fixture_root/packages/@overeng" -v target="$expected_target" '
  $1 != root "/otelite" && $1 != root "/otel-scrape" { exit 1 }
  $2 != target { exit 1 }
  END { if (NR != 8) exit 1 }
' "$tmpdir/cargo-calls"
for command in 'build --release' test 'clippy -- -D warnings' 'fmt --check'; do
  test "$(awk -F '\t' -v command="$command" '$3 == command { count++ } END { print count + 0 }' \
    "$tmpdir/cargo-calls")" -eq 2
done

mkdir -p "$tmpdir/outside"
if "$check_crate_script" "$fixture_root" ../../outside >/dev/null 2>&1; then
  echo "FAIL: workspace-escaping cargo crate path was accepted" >&2
  exit 1
fi

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
