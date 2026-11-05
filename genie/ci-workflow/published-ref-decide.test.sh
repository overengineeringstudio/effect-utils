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
legacy="$(git commit-tree "$tree" -p "$b" -p "$a" -m 'Legacy merge' -m "Published-From: $a")"
single="$(git commit-tree "$tree" -p "$legacy" -m 'Legacy single' -m "Published-From: $b")"
newer="$(git commit-tree "$tree" -p "$single" -m 'Newer main')"
git update-ref refs/heads/main "$newer"
assert_decision() {
  local expected="$1" tip="$2" target="$3" actual
  actual="$(decide "$tip" "$target" refs/heads/main)"
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
p="$(git commit-tree "$tree" -p "$o" -p "$a" -m "Publish A" -m "Published-From: $a")"
q="$(git commit-tree "$tree" -p "$p" -p "$b" -m "Publish B" -m "Published-From: $b")"
assert_decision noop "$p" "$a"
assert_decision push "$p" "$b"
assert_decision noop "$q" "$a"
assert_decision noop "$q" "$b"
assert_decision noop "$q" "$d"
# Legacy main commits cannot impersonate publisher tips with misleading trailers.
assert_decision noop "$legacy" "$b"
assert_decision noop "$single" "$b"
assert_decision push "$single" "$newer"
invalid="$(git commit-tree "$tree" -p "$d" -m Invalid -m "Published-From: $b")"
assert_decision diverged "$invalid" "$b"
invalid="$(git commit-tree "$tree" -p "$p" -p "$d" -m Invalid -m "Published-From: $d")"
assert_decision diverged "$invalid" "$b"
invalid="$(git commit-tree "$tree" -p "$p" -p "$b" -m Invalid -m "Published-From: $a")"
assert_decision diverged "$invalid" "$b"
# Newer run wins first: an older run must leave the actual ref unchanged.
git update-ref refs/heads/published "$p"
assert_decision push "$(git rev-parse published)" "$b"
git update-ref refs/heads/published "$q" "$p"
assert_decision noop "$(git rev-parse published)" "$a"
test "$(git rev-parse published)" = "$q"
# A stale lease rejects a commit based on the previous tip, even if it is a FF.
r="$(git commit-tree "$tree" -p "$p" -p "$b" -m "Raced B" -m "Published-From: $b")"
if git push --force-with-lease="refs/heads/published:$p" . "$r:refs/heads/published"; then
  echo 'stale published lease unexpectedly accepted' >&2
  exit 1
fi
test "$(git rev-parse published)" = "$q"
# Round-trip at the chunk boundary and full limit, including a real process launch.
for size in 75000 75001 300000; do
  printf "%${size}s" x > input
  outputs="$(manifest_outputs input)"
  while IFS= read -r line; do
    key="${line%%=*}"
    value="${line#*=}"
    test "${#value}" -le 100000
    printf -v "MANIFEST_BASE64_${key##*-}" %s "$value"
  done <<< "$outputs"
  export MANIFEST_BASE64_0 MANIFEST_BASE64_1 MANIFEST_BASE64_2 MANIFEST_BASE64_3
  bash -c ':'
  decode_manifest > decoded
  cmp input decoded
done
printf '%300001s' x > input
if manifest_outputs input > outputs 2> error; then
  echo 'over-limit manifest unexpectedly accepted' >&2
  exit 1
fi
test ! -s outputs
test "$(cat error)" = '::error::Manifest exceeds the 400000-character promotion output limit'
MANIFEST_BASE64_0='invalid!'
if decode_manifest > decoded 2> error; then
  echo 'invalid base64 unexpectedly accepted' >&2
  exit 1
fi
test ! -s decoded
echo 'published-ref-decide: 21 ancestry assertions, out-of-order/lease checks, and 5 transport checks passed'
