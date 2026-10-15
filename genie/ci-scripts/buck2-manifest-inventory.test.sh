#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
selector="$repo_root/genie/ci-scripts/buck2-manifest-inventory.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Honor the checkout's configured author, including managed-host identity hooks.
fixture_name="$(git -C "$repo_root" config user.name || printf fixture)"
fixture_email="$(git -C "$repo_root" config user.email || printf fixture@example.invalid)"

git init --quiet --bare "$tmp/origin"
git init --quiet -b main "$tmp/seed"
git -C "$tmp/seed" config user.name "$fixture_name"
git -C "$tmp/seed" config user.email "$fixture_email"
mkdir -p "$tmp/seed/nix/buck2-products"
printf 'initial\n' >"$tmp/seed/nix/buck2-products/manifest.json"
printf 'initial\n' >"$tmp/seed/source.txt"
git -C "$tmp/seed" add .
git -C "$tmp/seed" commit --quiet -m initial
base="$(git -C "$tmp/seed" rev-parse HEAD)"
git -C "$tmp/seed" remote add origin "$tmp/origin"
git -C "$tmp/seed" push --quiet origin main

for kind in source manifest; do
  # Exercise the same shallow checkout that Actions gives the selection helper.
  git clone --quiet --depth=1 --branch main "file://$tmp/origin" "$tmp/$kind"
  git -C "$tmp/$kind" config user.name "$fixture_name"
  git -C "$tmp/$kind" config user.email "$fixture_email"
  if [ "$kind" = manifest ]; then
    printf 'changed\n' >"$tmp/$kind/nix/buck2-products/manifest.json"
  else
    printf 'changed\n' >"$tmp/$kind/source.txt"
  fi
  git -C "$tmp/$kind" add .
  git -C "$tmp/$kind" commit --quiet -m "$kind change"
done

assert_mode() {
  local repo="$1" event="$2" base_sha="$3" expected="$4" actual
  actual="$(cd "$repo" && GITHUB_EVENT_NAME="$event" MANIFEST_BASE_SHA="$base_sha" bash "$selector" --select-mode)"
  if [ "$actual" != "$expected" ]; then
    echo "manifest-inventory-test: $event base=$base_sha expected $expected, got $actual" >&2
    exit 1
  fi
}

for event in pull_request merge_group; do
  assert_mode "$tmp/manifest" "$event" "$base" full
  assert_mode "$tmp/source" "$event" "$base" subset
  assert_mode "$tmp/source" "$event" '' full
  assert_mode "$tmp/source" "$event" 1111111111111111111111111111111111111111 full
  actual="$(cd "$tmp/source" && env -u MANIFEST_BASE_SHA GITHUB_EVENT_NAME="$event" bash "$selector" --select-mode)"
  [ "$actual" = full ] || { echo "manifest-inventory-test: unset base did not fail closed" >&2; exit 1; }
done
assert_mode "$tmp/manifest" push '' subset

# A newer base may differ at the manifest without this PR editing it. Selection
# must compare the merge base, not the two endpoints or a moving branch name.
printf 'advanced base\n' >"$tmp/seed/nix/buck2-products/manifest.json"
git -C "$tmp/seed" add .
git -C "$tmp/seed" commit --quiet -m 'advance base manifest'
git -C "$tmp/seed" push --quiet origin main
advanced_base="$(git -C "$tmp/seed" rev-parse HEAD)"
for event in pull_request merge_group; do
  assert_mode "$tmp/source" "$event" "$advanced_base" subset
done

echo 'manifest-inventory-selection-test: OK'
