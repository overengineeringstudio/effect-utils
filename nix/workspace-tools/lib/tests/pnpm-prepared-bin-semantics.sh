#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "$0")/../../../.." && pwd)}"
lib_dir="$repo_root/nix/workspace-tools/lib"
fixture="$lib_dir/tests/fixtures/pnpm-bin-projector"
prepared_tree="$lib_dir/prepared-pnpm-tree.cjs"
projector="$lib_dir/pnpm-bin-projector.cjs"
helper="$lib_dir/mk-pnpm-deps.nix"
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/pnpm-prepared-bin-semantics.XXXXXX")"
workspace="$sandbox/workspace"
mkdir -p "$workspace"
cleanup() {
  chmod -R u+w "$sandbox" 2>/dev/null || true
  rm -rf "$sandbox"
}
trap cleanup EXIT

fail() {
  printf 'pnpm prepared bin semantics: %s\n' "$*" >&2
  exit 1
}

assert_symlink_target() {
  local link="$1"
  local expected="$2"
  [ -L "$link" ] || fail "expected symlink: $link"
  [ "$(readlink -f "$link")" = "$(readlink -f "$expected")" ] ||
    fail "unexpected target for $link"
  [ -x "$link" ] || fail "expected executable projection: $link"
}

cp -R "$fixture"/. "$workspace"/
mkdir -p \
  "$workspace/node_modules/@fixture" \
  "$workspace/packages/scoped/node_modules/.bin" \
  "$workspace/packages/object/node_modules"
ln -s ../../packages/scoped "$workspace/node_modules/@fixture/scoped-dependency"
ln -s ../packages/aliased "$workspace/node_modules/dependency-alias"
ln -s ../packages/object "$workspace/node_modules/object-tools"
ln -s ../packages/directory "$workspace/node_modules/directory-tools"

# Normalization owns every .bin shape, including projection directories outside
# the usual node_modules location and a symlink projection, without following
# the latter into package data.
mkdir -p \
  "$workspace/node_modules/.bin" \
  "$workspace/packages/directory/.bin" \
  "$workspace/bin-symlink-target"
printf '#!/bin/sh\nexit 99\n' > "$workspace/node_modules/.bin/stale"
printf '#!/bin/sh\nexit 96\n' > "$workspace/packages/directory/.bin/stale"
printf 'package data\n' > "$workspace/bin-symlink-target/keep"
ln -s ../../../bin-symlink-target "$workspace/packages/object/node_modules/.bin"
printf '#!/bin/sh\nexit 98\n' > "$workspace/packages/scoped/node_modules/.bin/stale"
node "$prepared_tree" normalize "$workspace"
[ -z "$(find "$workspace" -name .bin -print -quit)" ] || fail 'normalization retained a .bin projection'
[ -f "$workspace/bin-symlink-target/keep" ] || fail 'normalization followed a .bin symlink'

# The scan is independent of normalization and rejects any surviving projection.
mkdir -p "$workspace/node_modules/.bin"
printf '#!/bin/sh\nexit 97\n' > "$workspace/node_modules/.bin/survivor"
if node "$prepared_tree" scan "$workspace" 2>"$workspace/scan-error"; then
  fail 'strict scan accepted a surviving bin shim'
fi
grep -F 'node_modules/.bin' "$workspace/scan-error" >/dev/null ||
  fail 'strict scan did not identify the surviving projection'
rm -rf "$workspace/node_modules/.bin"
node "$prepared_tree" scan "$workspace"

# Nix store payloads are read-only. Restore establishes a mutable projection
# workspace through tar metadata before the projector reaches nested virtual
# store node_modules directories.
readonly_payload="$sandbox/prepared-readonly"
restored_payload="$sandbox/restored"
cp -R "$workspace" "$readonly_payload"
chmod -R a-w "$readonly_payload"
mkdir -p "$restored_payload"
tar \
  --create \
  --mode='u+w' \
  --file - \
  --directory "$readonly_payload" \
  . \
  | tar \
    --extract \
    --file - \
    --directory "$restored_payload" \
    --delay-directory-restore
node "$projector" --platform linux "$restored_payload" >/dev/null
assert_symlink_target \
  "$restored_payload/packages/scoped/node_modules/.bin/scoped-tool" \
  "$restored_payload/packages/scoped/cli.js"

# Restore must never mutate an archived bin. Its only bin operation is the pure
# post-restore projector, while preparation runs the independent strict scan.
if grep -Eq 'chmodBinScriptsWritableScript|restorePreparedWorkspaceScript|PREPARED_WORKSPACE_PLACEHOLDER' "$helper"; then
  fail 'restore still contains archived-bin mutation machinery'
fi
grep -F 'preparedPnpmTreeScript = pkgs.writeText' "$helper" >/dev/null ||
  fail 'prepared-tree helper is not an explicit Nix store input'
grep -F 'pnpmBinProjectorScript = pkgs.writeText' "$helper" >/dev/null ||
  fail 'bin projector is not an explicit Nix store input'
grep -F -- "--mode='u+w'" "$helper" >/dev/null ||
  fail 'restore does not establish a writable projection workspace'
grep -F 'preparedPnpmTreeScript} scan .' "$helper" >/dev/null ||
  fail 'prepared artifact strict scan is not wired'
grep -F 'pnpmBinProjectorScript} "$PREPARED_WORKSPACE_TARGET"' "$helper" >/dev/null ||
  fail 'restore does not delegate bin ownership to the pure projector'

before_hashes="$(sha256sum \
  "$workspace/local-cli.js" \
  "$workspace/packages/scoped/cli.js" \
  "$workspace/packages/aliased/cli.js" \
  "$workspace/packages/object/first.js" \
  "$workspace/packages/object/second.js" \
  "$workspace/packages/directory/commands/directory-one" \
  "$workspace/packages/directory/commands/directory-two")"
before_modes="$(stat -c '%a %n' \
  "$workspace/local-cli.js" \
  "$workspace/packages/scoped/cli.js" \
  "$workspace/packages/aliased/cli.js" \
  "$workspace/packages/object/first.js" \
  "$workspace/packages/object/second.js" \
  "$workspace/packages/directory/commands/directory-one" \
  "$workspace/packages/directory/commands/directory-two")"

node "$projector" --platform linux "$workspace" >"$workspace/linux-report"
assert_symlink_target "$workspace/node_modules/.bin/workspace-tool" "$workspace/local-cli.js"
assert_symlink_target "$workspace/node_modules/.bin/scoped-tool" "$workspace/packages/scoped/cli.js"
assert_symlink_target "$workspace/node_modules/.bin/published-tool" "$workspace/packages/aliased/cli.js"
assert_symlink_target "$workspace/node_modules/.bin/object-first" "$workspace/packages/object/first.js"
assert_symlink_target "$workspace/node_modules/.bin/object-scoped" "$workspace/packages/object/second.js"
assert_symlink_target "$workspace/node_modules/.bin/directory-one" "$workspace/packages/directory/commands/directory-one"
assert_symlink_target "$workspace/node_modules/.bin/directory-two" "$workspace/packages/directory/commands/directory-two"
assert_symlink_target "$workspace/packages/scoped/node_modules/.bin/scoped-tool" "$workspace/packages/scoped/cli.js"
grep -F '"dependencyName":"dependency-alias"' "$workspace/linux-report" >/dev/null ||
  fail 'projection report omitted the aliased dependency'
grep -F '"platform":"linux"' "$workspace/linux-report" >/dev/null ||
  fail 'projection report omitted the Linux platform policy'

# Deterministic overwrite makes the projector, not restored state, authoritative.
rm "$workspace/node_modules/.bin/workspace-tool"
printf 'stale shim\n' > "$workspace/node_modules/.bin/workspace-tool"
node "$projector" --platform linux "$workspace" >/dev/null
assert_symlink_target "$workspace/node_modules/.bin/workspace-tool" "$workspace/local-cli.js"

# Darwin and Linux share the POSIX symlink policy. Reprojecting must preserve
# immutable targets, including their shebangs and executable modes.
node "$prepared_tree" normalize "$workspace"
node "$projector" --platform darwin "$workspace" >"$workspace/darwin-report"
assert_symlink_target "$workspace/node_modules/.bin/scoped-tool" "$workspace/packages/scoped/cli.js"
grep -F '"platform":"darwin"' "$workspace/darwin-report" >/dev/null ||
  fail 'projection report omitted the Darwin platform policy'
[ "$before_hashes" = "$(sha256sum \
  "$workspace/local-cli.js" \
  "$workspace/packages/scoped/cli.js" \
  "$workspace/packages/aliased/cli.js" \
  "$workspace/packages/object/first.js" \
  "$workspace/packages/object/second.js" \
  "$workspace/packages/directory/commands/directory-one" \
  "$workspace/packages/directory/commands/directory-two")" ] || fail 'projector rewrote package bin contents'
[ "$before_modes" = "$(stat -c '%a %n' \
  "$workspace/local-cli.js" \
  "$workspace/packages/scoped/cli.js" \
  "$workspace/packages/aliased/cli.js" \
  "$workspace/packages/object/first.js" \
  "$workspace/packages/object/second.js" \
  "$workspace/packages/directory/commands/directory-one" \
  "$workspace/packages/directory/commands/directory-two")" ] || fail 'projector changed package bin executable modes'
head -n 1 "$workspace/node_modules/.bin/workspace-tool" | grep -F '#!/usr/bin/env node' >/dev/null ||
  fail 'projected bin did not preserve its target shebang'
[ ! -e "$workspace/lifecycle-ran" ] || fail 'projector executed a lifecycle script'

if node "$projector" --platform win32 "$workspace" >/dev/null 2>"$workspace/platform-error"; then
  fail 'projector accepted an unsupported shim platform'
fi
grep -F 'unsupported bin projection platform' "$workspace/platform-error" >/dev/null ||
  fail 'unsupported platform failure was not explicit'

printf 'pnpm prepared bin semantics: ok\n'
