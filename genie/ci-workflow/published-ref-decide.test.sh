#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/published-ref-decide.sh"
root="$PWD"
mkdir -p tmp/published-ref-tests
repo="$(mktemp -d "$PWD/tmp/published-ref-tests/repo.XXXXXX")"
trap 'cd "$root"; rm -rf "$repo"; rmdir "$(dirname "$repo")" 2>/dev/null || true' EXIT
git init --quiet "$repo"
cd "$repo"
export GIT_AUTHOR_NAME=published-ref-test GIT_COMMITTER_NAME=published-ref-test
export GIT_AUTHOR_EMAIL=published-ref-test@example.invalid GIT_COMMITTER_EMAIL=published-ref-test@example.invalid
tree="$(git mktree </dev/null)"
o="$(git commit-tree "$tree" -m O)"
a="$(git commit-tree "$tree" -p "$o" -m A)"
b="$(git commit-tree "$tree" -p "$a" -m B)"
d="$(git commit-tree "$tree" -p "$o" -m divergent)"
assert_decision() {
  local expected="$1" tip="$2" target="$3" actual
  actual="$(decide "$tip" "$target")"
  if [ "$actual" != "$expected" ]; then
    echo "expected $expected, got $actual for tip=$tip target=$target" >&2
    exit 1
  fi
}
assert_decision create '' "$b"
assert_decision noop "$b" "$b"
assert_decision noop "$b" "$a"
assert_decision push "$o" "$b"
# O -> A -> B: A wins the first push; B must still advance the ref on retry.
assert_decision push "$a" "$b"
# A rejected creation sees the newly created ancestor and becomes a FF push.
assert_decision create '' "$b"
assert_decision push "$a" "$b"
assert_decision diverged "$d" "$b"
echo 'published-ref-decide: 8 ancestry assertions passed'
