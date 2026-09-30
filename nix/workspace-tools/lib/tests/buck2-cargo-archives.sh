#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
fixture="$(mktemp -d)"
trap 'chmod -R u+w "$fixture/extracted" 2>/dev/null || true; rm -rf "$fixture"' EXIT
mkdir -p "$fixture/third-party" "$fixture/source/src"
printf 'pub fn demo() -> u32 { 42 }\n' > "$fixture/source/src/lib.rs"
ln -s lib.rs "$fixture/source/src/current.rs"
printf 'git_archive(\n)\n' > "$fixture/third-party/BUCK"
# Real Reindeer graphs can exceed 20,000 lines; Git rule detection must not overflow Nix's stack.
for ((line = 0; line < 22000; line++)); do
  printf '# generated graph line %d\n' "$line"
done >> "$fixture/third-party/BUCK"
rev=0123456789abcdef0123456789abcdef01234567
pin=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
prefix=demo-0123456789abcdef0123456789abcdef01234567
cat > "$fixture/third-party/git-archives.json" <<EOF
{"schema":"effect-utils/buck2-git-archives/v1","archives":[{"repo":"https://github.com/owner/demo.git","rev":"$rev","url":"https://github.com/owner/demo/archive/$rev.tar.gz","sha256":"$pin","strip_prefix":"$prefix"}]}
EOF
export CARGO_ARCHIVES_REPO="$repo_root" CARGO_ARCHIVES_BUCK="$fixture/third-party/BUCK" CARGO_ARCHIVES_SOURCE="$fixture/source"
common='let
  repo = builtins.toPath (builtins.getEnv "CARGO_ARCHIVES_REPO");
  flake = builtins.getFlake (toString repo);
  pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  buck = builtins.toPath (builtins.getEnv "CARGO_ARCHIVES_BUCK");
  src = builtins.toPath (builtins.getEnv "CARGO_ARCHIVES_SOURCE");
  rev = "0123456789abcdef0123456789abcdef01234567";
  archives = import (repo + "/nix/workspace-tools/lib/buck2-cargo-archives.nix");
in '
expr="$common archives { inherit pkgs; thirdPartyBuckFiles = [ buck ]; gitSources.\"owner/demo\" = src; }"
root="$(nix build --impure --no-link --print-out-paths --expr "$expr")"
archive="$root/$pin.tgz"
test -f "$archive" && test -f "$root/$pin.source.sha256"
test "$(tar -tzf "$archive" | sort)" = "$(printf '%s\n' "$prefix/" "$prefix/src/" "$prefix/src/lib.rs" "$prefix/src/current.rs" | sort)"
test "$(tar -xOf "$archive" "$prefix/src/lib.rs")" = 'pub fn demo() -> u32 { 42 }'
mkdir -p "$fixture/extracted"
tar -xzf "$archive" -C "$fixture/extracted"
test "$(readlink "$fixture/extracted/$prefix/src/current.rs")" = lib.rs
test "$(cat "$fixture/extracted/$prefix/src/current.rs")" = 'pub fn demo() -> u32 { 42 }'
actual="$(nix hash file --type sha256 --base16 "$archive")"
test "$actual" != "$pin"
test "$(nix build --impure --no-link --print-out-paths --expr "$expr")" = "$root"
bun "$repo_root/buck2/dependencies/nix-archive.ts" --root "$root" --sha256 "$pin" --source-repo 'https://github.com/owner/demo.git' --source-rev "$rev" --output "$fixture/copied.tgz"
cmp "$archive" "$fixture/copied.tgz"
if bun "$repo_root/buck2/dependencies/nix-archive.ts" --root "$root" --sha256 "$pin" --source-repo 'https://github.com/other/demo' --source-rev "$rev" --output "$fixture/wrong.tgz" > "$fixture/error" 2>&1; then
  echo 'buck2-cargo-archives-test: wrong source identity was accepted' >&2
  exit 1
fi
grep -Fq 'source digest manifest mismatch' "$fixture/error"
if nix eval --impure --raw --expr "$common toString (archives { inherit pkgs; thirdPartyBuckFiles = [ buck ]; gitSources.\"owner/demo\" = { outPath = src; rev = \"ffffffffffffffffffffffffffffffffffffffff\"; }; })" > "$fixture/error" 2>&1; then
  echo 'buck2-cargo-archives-test: mismatched flake rev was accepted' >&2
  exit 1
fi
grep -Fq 'does not match Cargo.lock rev' "$fixture/error"
pin="$actual"
cat > "$fixture/third-party/git-archives.json" <<EOF
{"schema":"effect-utils/buck2-git-archives/v1","archives":[{"repo":"https://github.com/owner/demo.git","rev":"$rev","url":"https://github.com/owner/demo/archive/$rev.tar.gz","sha256":"$pin","strip_prefix":"$prefix","source":"nix"}]}
EOF
root="$(nix build --impure --no-link --print-out-paths --expr "$expr")"
test "$(nix hash file --type sha256 --base16 "$root/$pin.tgz")" = "$pin"
bun "$repo_root/buck2/dependencies/nix-archive.ts" --root "$root" --sha256 "$pin" --source-repo 'https://github.com/owner/demo.git' --source-rev "$rev" --output "$fixture/pinned.tgz"
cmp "$root/$pin.tgz" "$fixture/pinned.tgz"
if nix eval --impure --raw --expr "$common toString (archives { inherit pkgs; thirdPartyBuckFiles = [ buck ]; })" > "$fixture/error" 2>&1; then
  echo 'buck2-cargo-archives-test: Nix source pin accepted without an override' >&2
  exit 1
fi
grep -Fq 'requires gitSources.owner/demo' "$fixture/error"
printf 'pub fn changed() -> u32 { 99 }\n' > "$fixture/source/src/lib.rs"
if nix build --impure --no-link --expr "$expr" > "$fixture/error" 2>&1; then
  echo 'buck2-cargo-archives-test: source bytes drifted from the pinned sha256' >&2
  exit 1
fi
grep -Fq 'does not match git-archives.json' "$fixture/error"
nix build --impure --no-link --expr "$common import (repo + \"/nix/workspace-tools/lib/tests/buck2-git-source-archive-hardlinks.nix\") { inherit pkgs; }"
echo 'buck2-cargo-archives-test: PASS local source, deterministic archive, digest and rev checks'
