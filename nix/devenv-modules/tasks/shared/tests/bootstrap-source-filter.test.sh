#!/usr/bin/env bash
set -euo pipefail

tests_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_filter="$tests_dir/../bootstrap-source-filter.nix"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

fixture="$tmpdir/fixture"
mkdir -p "$fixture/nested"
printf 'source\n' > "$fixture/source.ts"
printf '{}\n' > "$fixture/.oxlintrc.json"
printf 'lookalike\n' > "$fixture/.oxlint-with-plugins-source.json.ts"
printf '{}\n' > "$fixture/.oxlint-with-plugins.root.json"
printf '{}\n' > "$fixture/nested/.oxlint-with-plugins.nested.json"
printf 'lookalike\n' > "$fixture/.source.bun-build"
printf 'transient\n' > "$fixture/.18ce97f2f777fbdf-00000000.bun-build"
printf 'transient\n' > "$fixture/nested/.0123abcd-deadbeef.bun-build"

snapshot="$(nix eval --raw --impure --expr "
  toString (builtins.path {
    path = $fixture;
    name = \"bootstrap-source-filter-fixture\";
    filter = import $source_filter;
  })
")"

test -f "$snapshot/source.ts"
test -f "$snapshot/.oxlintrc.json"
test -f "$snapshot/.oxlint-with-plugins-source.json.ts"
test ! -e "$snapshot/.oxlint-with-plugins.root.json"
test ! -e "$snapshot/nested/.oxlint-with-plugins.nested.json"
test -f "$snapshot/.source.bun-build"
test ! -e "$snapshot/.18ce97f2f777fbdf-00000000.bun-build"
test ! -e "$snapshot/nested/.0123abcd-deadbeef.bun-build"

echo "bootstrap source filter test passed"
