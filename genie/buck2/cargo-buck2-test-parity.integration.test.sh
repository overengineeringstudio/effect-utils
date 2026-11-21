#!/usr/bin/env bash
set -euo pipefail
# genie:buck2:test supplies the existing pinned stage-zero Cargo/vendor inputs.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
: "${STAGE0_VENDOR:?Run through genie:buck2:test or supply its pinned STAGE0_VENDOR}"
: "${STAGE0_CARGO:?Missing pinned Cargo executable}"
: "${STAGE0_RUSTC:?Missing pinned rustc executable}"
status_before="$(git status --porcelain --untracked-files=all)"
FIXTURE=genie/buck2/fixtures/cargo-test-parity
work="$(mktemp -d "$ROOT/genie/buck2/fixtures/cargo-test-parity.probe.XXXXXX")"
cargo_home="$(mktemp -d "${TMPDIR:-/tmp}/cargo-test-parity-home.XXXXXX")"
cleanup() {
  local status=$? status_after
  trap - EXIT
  # Only our copied regular-file fixture and fresh Cargo home; never shared views.
  find "$work" "$cargo_home" -depth -delete
  status_after="$(git status --porcelain --untracked-files=all)"
  if [[ "$status_before" != "$status_after" ]]; then
    printf 'FAIL: parity changed git status (tracked or untracked files)\n' >&2
    printf 'BEFORE:\n%s\nAFTER:\n%s\n' "$status_before" "$status_after" >&2
    exit 1
  fi
  printf 'GIT_STATUS_UNCHANGED=1\n'
  exit "$status"
}
trap cleanup EXIT
cp -R "$FIXTURE/." "$work/"
# Genie marks checked-in outputs read-only; regenerate only our disposable copy.
rm -f "$work/BUCK"
export PARITY_FIXTURE="$work" CARGO_HOME="$cargo_home" CARGO_NET_OFFLINE=true
export RUSTC="$STAGE0_RUSTC"
export CARGO_TARGET_DIR="$cargo_home/target"
printf '[source.crates-io]\nreplace-with = "nix-vendor"\n[source.nix-vendor]\ndirectory = "%s"\n' "$STAGE0_VENDOR" > "$CARGO_HOME/config.toml"
python3 - "$ROOT" <<'PY'
import collections
import os
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
fixture = pathlib.Path(os.environ['PARITY_FIXTURE'])
package = fixture.relative_to(root).as_posix()
cargo_bin = os.environ['STAGE0_CARGO']
buck = os.environ.get('BUCK2_BIN', 'buck2')
harnesses = [('unit-lib', ['--lib']), ('unit-bin-cargo-test-parity', ['--bin', 'cargo-test-parity']), ('integration-first', ['--test', 'first']), ('integration-second', ['--test', 'second'])]
generate = 'const {pathToFileURL} = await import("node:url"); const base = process.env.PARITY_FIXTURE; const p = await import(pathToFileURL(base + "/BUCK.genie.ts").href); await Bun.write(base + "/BUCK", p.default.stringify({cwd: process.cwd(), location: base}));'

def run(command):
    completed = subprocess.run(command, cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print('$ ' + ' '.join(map(str, command)), flush=True)
    print(completed.stdout, end='', flush=True)
    print('STATUS=' + str(completed.returncode), flush=True)
    if completed.returncode:
        raise SystemExit(completed.returncode)
    return completed.stdout

def compare(entries):
    cargo, buck_tests = [], []
    for harness, cargo_args in entries:
        cargo_out = run([cargo_bin, 'test', '--offline', '--locked', '--manifest-path', str(fixture / 'Cargo.toml'), *cargo_args, '--', '--list'])
        label = '//' + package + ':' + harness
        buck_out = run([buck, 'test', '--test-executor-stdout=-', '--test-executor-stderr=-', label, '--', '--test-arg=--list'])
        for output, inventory in [(cargo_out, cargo), (buck_out, buck_tests)]:
            clean = re.sub(r'\x1b\[[0-9;]*m', '', output)
            clean = re.sub(r'^\[\d{4}-[^\]]+\]\s?', '', clean, flags=re.MULTILINE)
            inventory.extend(('cargo-test-parity', harness, name) for name in re.findall(r'^([A-Za-z0-9_:]+): test\s*$', clean, re.MULTILINE))
    print('CARGO INVENTORY\n' + '\n'.join('|'.join(row) for row in sorted(cargo)))
    print('BUCK INVENTORY\n' + '\n'.join('|'.join(row) for row in sorted(buck_tests)))
    missing = collections.Counter(cargo) - collections.Counter(buck_tests)
    extra = collections.Counter(buck_tests) - collections.Counter(cargo)
    assert cargo, 'empty Cargo test inventory'
    assert not missing and not extra, f'parity diff: missing={missing}, extra={extra}'
    print(f'PARITY: {len(cargo)} tests, {len(entries)} harnesses; identical multisets (including ignored tests). Doctests: unsupported; disabled only in this fixture.')

run(['bun', '--eval', generate])
# Resolver 3 changes lock generation policy, not projection of a committed lock.
# Compare only in the disposable fixture; keep the checked-in resolver/lock untouched.
locked = (fixture / 'Cargo.lock').read_bytes()
resolver_two = (fixture / 'BUCK').read_text()
manifest = fixture / 'Cargo.toml'
original_manifest = manifest.read_text()
assert 'resolver = "2"' in original_manifest
manifest.write_text(original_manifest.replace('resolver = "2"', 'resolver = "3"', 1))
run(['bun', '--eval', generate])
targets = lambda output: re.sub(r'^# Semantic fingerprint: .*\n', '', output, flags=re.MULTILINE)
assert targets(resolver_two) == targets((fixture / 'BUCK').read_text()), 'resolver 2/3 target diff'
assert (fixture / 'Cargo.lock').read_bytes() == locked
print('RESOLVER_2_3_TARGETS_IDENTICAL=1; testing resolver 3 with unchanged Cargo.lock')
compare(harnesses)
# Execute assertions too: cwd/resources/dev deps/declared binary artifact.
run([cargo_bin, 'test', '--offline', '--locked', '--manifest-path', str(fixture / 'Cargo.toml')])
run([buck, 'test', *['//' + package + ':' + name for name, _ in harnesses]])
(fixture / 'tests/regenerated.rs').write_text('#[test] fn newly_discovered() {}\n')
run(['bun', '--eval', generate])
assert 'name = "integration-regenerated"' in (fixture / 'BUCK').read_text()
compare([*harnesses, ('integration-regenerated', ['--test', 'regenerated'])])
assert (fixture / 'Cargo.lock').read_bytes() == locked, 'Cargo.lock changed'
PY
