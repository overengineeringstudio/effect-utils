#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 7 ]; then
  echo "usage: $0 <generate|check> <repository-root> <workspace-root> <third-party-buck> <reindeer> <cargo> <rustc>" >&2
  exit 64
fi

mode="$1"
root="$2"
workspace_relative="$3"
third_party_buck_relative="$4"
reindeer="$5"
cargo="$6"
rustc="$7"

case "$mode" in
  generate | check) ;;
  *)
    echo "buck2-rust-deps: unknown mode: $mode" >&2
    exit 64
    ;;
esac

cd "$root"
root="$(pwd -P)"
cd "$root/$workspace_relative"
workspace="$(pwd -P)"
case "$workspace" in
  "$root" | "$root"/*) ;;
  *)
    echo "buck2-rust-deps: workspace root escapes repository: $workspace_relative" >&2
    exit 64
    ;;
esac
case "$third_party_buck_relative" in
  /* | *\\* | ../* | */../* | */..)
    echo "buck2-rust-deps: third-party BUCK must be repository-relative: $third_party_buck_relative" >&2
    exit 64
    ;;
esac
if [ "$(basename "$third_party_buck_relative")" != BUCK ]; then
  echo "buck2-rust-deps: third-party graph path must end in BUCK: $third_party_buck_relative" >&2
  exit 64
fi
third_party="$(cd "$root/$(dirname "$third_party_buck_relative")" && pwd -P)"
case "$third_party" in
  "$root" | "$root"/*) ;;
  *)
    echo "buck2-rust-deps: third-party graph escapes repository: $third_party_buck_relative" >&2
    exit 64
    ;;
esac
third_party_buck="$third_party/BUCK"
if [ -L "$third_party_buck" ]; then
  echo "buck2-rust-deps: third-party BUCK must not be a symlink: $third_party_buck_relative" >&2
  exit 64
fi
config="$workspace/reindeer.toml"
lock="$workspace/Cargo.lock"
cargo_home="$root/.devenv/reindeer-cargo-home"
configured_third_party=""
while IFS= read -r line; do
  if [[ "$line" =~ ^[[:space:]]*third_party_dir[[:space:]]*=[[:space:]]*\"([^\"]+)\"[[:space:]]*(#.*)?$ ]]; then
    configured_third_party="${BASH_REMATCH[1]}"
  fi
done <"$config"
if [ -z "$configured_third_party" ]; then
  echo "buck2-rust-deps: ${config#"$root"/} must define third_party_dir" >&2
  exit 1
fi
configured_third_party="$(cd "$workspace/$configured_third_party" && pwd -P)"
if [ "$configured_third_party" != "$third_party" ]; then
  echo "buck2-rust-deps: third-party BUCK disagrees with ${config#"$root"/} third_party_dir" >&2
  exit 1
fi

if ! grep -Eq '^[[:space:]]*vendor[[:space:]]*=[[:space:]]*false([[:space:]]*(#.*)?)?$' "$config"; then
  echo "buck2-rust-deps: ${config#"$root"/} must select vendor = false" >&2
  exit 1
fi

fixup_violations=0
for fixup in "$third_party"/fixups/*/fixups.toml; do
  [ -f "$fixup" ] || continue
  if grep -nE '^[[:space:]]*(omit_srcs|extra_srcs)[[:space:]]*=' "$fixup"; then
    echo "buck2-rust-deps: non-vendored fixup uses a discarded source key: ${fixup#"$root"/}" >&2
    fixup_violations=1
  else
    grep_status=$?
    if [ "$grep_status" -ne 1 ]; then
      echo "buck2-rust-deps: failed to inspect fixup: ${fixup#"$root"/}" >&2
      exit "$grep_status"
    fi
  fi
done
if [ "$fixup_violations" -ne 0 ]; then
  exit 1
fi

mkdir -p "$cargo_home"
lock_before="$(mktemp "$cargo_home/Cargo.lock.before.XXXXXX")"
candidate="$(mktemp "$third_party/.BUCK.next.XXXXXX")"
cleanup() {
  rm -f "$lock_before" "$candidate"
}
trap cleanup EXIT
cp "$lock" "$lock_before"

set +e
CARGO_HOME="$cargo_home" "$reindeer" \
  --cargo-path "$cargo" \
  --rustc-path "$rustc" \
  --config "$config" \
  buckify --stdout >"$candidate"
buckify_status=$?
set -e

if ! cmp -s "$lock_before" "$lock"; then
  echo "buck2-rust-deps: Reindeer changed authoritative ${lock#"$root"/}" >&2
  exit 1
fi
if [ "$buckify_status" -ne 0 ]; then
  exit "$buckify_status"
fi
if grep -Fq 'vendor/' "$candidate"; then
  echo "buck2-rust-deps: non-vendored graph unexpectedly references vendor/" >&2
  exit 1
fi

archive_count="$(grep -Ec '^http_archive[(]$' "$candidate" || true)"
sha256_count="$(grep -Ec '^    sha256 = "[0-9a-f]{64}",$' "$candidate" || true)"
if [ "$archive_count" -eq 0 ] || [ "$sha256_count" -ne "$archive_count" ]; then
  echo "buck2-rust-deps: every generated http_archive must carry one sha256 pin" >&2
  exit 1
fi

case "$mode" in
  generate)
    chmod 0644 "$candidate"
    mv "$candidate" "$third_party_buck"
    ;;
  check)
    if ! cmp -s "$third_party_buck" "$candidate"; then
      echo "buck2-rust-deps: generated Reindeer graph is stale" >&2
      exit 1
    fi
    ;;
esac
