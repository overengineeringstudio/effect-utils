#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/manifest-pr-decide.sh"
tmp="$(mktemp -d)"
trap 'rm -r "$tmp"' EXIT
# Exercise the actual helper in the same depth-one checkout used by both jobs.
helper="$(realpath "$(dirname "${BASH_SOURCE[0]}")/manifest-pr-decide.sh")"
repository="$(git -C "$(dirname "$helper")" rev-parse --show-toplevel)"
git clone --quiet --depth 1 "file://$repository" "$tmp/shallow"
test "$(git -C "$tmp/shallow" rev-parse --is-shallow-repository)" = true
(
  cd "$tmp/shallow"
  bootstrap_pins > "$tmp/pins"
)
jq -e 'type == "array" and length > 0 and all(.[]; type == "string")' "$tmp/pins" >/dev/null
# A genuine evaluation error must abort the strict job before any later write.
mv "$tmp/shallow/nix/buck2-products/cache.nix" "$tmp/cache.nix"
if bash -euo pipefail -c 'cd "$1"; source "$2"; pins="$(bootstrap_pins)"; touch "$3"' \
  bash "$tmp/shallow" "$helper" "$tmp/write-reached" 2> "$tmp/eval-error"; then
  echo 'bootstrap_pins unexpectedly accepted an invalid checkout' >&2
  exit 1
fi
test -s "$tmp/eval-error"
test ! -e "$tmp/write-reached"
export GITHUB_TOKEN=read-only
pins='["bootstrap"]'
now=1760000000
recent=1759999999
old=1759913600
api_epoch="$recent"
api_fail=false
gh() {
  test "$GH_TOKEN" = read-only
  test "$*" = 'api repos/example/repo/commits?path=nix/buck2-products/manifest.json&sha=main&per_page=1'
  if "$api_fail"; then return 1; fi
  printf '[{"commit":{"committer":{"date":"%s"}}}]\n' "$(date -u -d "@$api_epoch" +%FT%TZ)"
}
printf '%s\n' '{"products":[{"name":"bootstrap","value":1},{"name":"other","value":1}]}' > "$tmp/main"
jq '.products[0].value = 2' "$tmp/main" > "$tmp/bootstrap"
jq '.products[1].value = 2' "$tmp/main" > "$tmp/other"
assert_decision() {
  local actual
  actual="$(manifest_pr_decide "$tmp/main" "$tmp/$1" "$pins" example/repo "$now")"
  test "$actual" = "$2" || { echo "Expected $2, got $actual" >&2; exit 1; }
}
assert_decision bootstrap open
assert_decision other skip-recent-safety-net
api_epoch="$old"
assert_decision other open
assert_decision main skip-no-diff
api_fail=true
assert_decision other skip-unchanged-genie 2> "$tmp/warning"
test -s "$tmp/warning"
assert_decision bootstrap open
jq '.products |= reverse' "$tmp/main" > "$tmp/reordered"
assert_decision reordered skip-no-diff
# The write-time guard prevents a stale bootstrap proposal replacing a newer one.
remote_tip=newer
remote_fail=false
git() {
  test "$*" = 'ls-remote origin refs/heads/main'
  if "$remote_fail"; then return 1; fi
  printf '%s\trefs/heads/main\n' "$remote_tip"
}
assert_writer() {
  local decision
  decision="$(manifest_pr_decide "$tmp/main" "$tmp/bootstrap" "$pins" example/repo "$now")"
  if [ "$decision" = open ]; then decision="$(manifest_pr_writer_decide "$1")"; fi
  test "$decision" = "$2"
}
assert_writer older skip-superseded 2> "$tmp/superseded"
test -s "$tmp/superseded"
assert_writer newer open
remote_fail=true
assert_writer newer skip-superseded 2> "$tmp/remote-warning"
test -s "$tmp/remote-warning"
assert_healing() {
  local decision
  decision="$(manifest_pr_decide "$tmp/main" "$tmp/other" "$pins" example/repo "$now")"
  test "$(manifest_pr_heal_decide "$decision" "$tmp/other" "$tmp/$1" "$pins")" = "$2"
}
api_fail=false
api_epoch="$recent"
assert_healing bootstrap open
assert_healing main skip-recent-safety-net
assert_healing missing open 2> "$tmp/heal-warning"
test -s "$tmp/heal-warning"
api_fail=true
assert_healing bootstrap open 2> "$tmp/history-healing"
test -s "$tmp/history-healing"
test "$(manifest_pr_heal_decide skip-no-diff "$tmp/main" "$tmp/bootstrap" "$pins")" = close
# The queue lookup uses the read-only token, while pushes keep their existing auth.
export GH_TOKEN=publisher-write
queue_result=false
lookup_fail=false
push_status=0
push_output=pushed
gh() {
  test "$GH_TOKEN" = read-only
  test "$1 $2" = 'api graphql'
  [[ "$*" == *'mergeQueueEntry { id }'* ]]
  [[ "$*" == *'owner=example'* && "$*" == *'name=repo'* ]]
  [[ "$*" == *'branch=automation/buck2-products-manifest'* ]]
  if "$lookup_fail"; then echo 'lookup failed' >&2; return 1; fi
  echo "$queue_result"
}
git() {
  test "$GH_TOKEN" = publisher-write
  test "$*" = 'push --force-with-lease origin HEAD:refs/heads/automation/buck2-products-manifest'
  touch "$tmp/pushed"
  echo "$push_output" >&2
  return "$push_status"
}
assert_push() {
  local expected="$1" pushed="$2" decision
  rm -f "$tmp/pushed" "$tmp/edited"
  # Mirror the strict workflow: a failed helper aborts, skip-queued exits before PR edits.
  (
    decision="$(manifest_pr_writer_push example/repo automation/buck2-products-manifest)"
    if [ "$decision" = skip-queued ]; then exit 0; fi
    test "$decision" = open
    touch "$tmp/edited"
  ) > "$tmp/push-stdout" 2> "$tmp/push-stderr"
  if [ "$pushed" = yes ]; then test -e "$tmp/pushed"; else test ! -e "$tmp/pushed"; fi
  if [ "$expected" = skip-queued ]; then
    test ! -e "$tmp/edited"
    test ! -s "$tmp/push-stdout"
    [[ "$(cat "$tmp/push-stderr")" == *'::notice::Manifest PR: skip-queued;'* ]]
  else
    test -e "$tmp/edited"
  fi
}
queue_result=true
assert_push skip-queued no
queue_result=false
assert_push open yes
lookup_fail=true
assert_push open yes
lookup_fail=false
push_status=1
push_output='remote: error: GH006: Protected branch update failed. A pull request for this branch has been added to a merge queue.'
export -f gh git
export tmp queue_result lookup_fail push_status push_output
assert_push skip-queued yes
# Only the combination of GH006 and merge queue can turn a push error into a skip.
for push_output in 'remote: GH006: Protected branch update failed' \
  'remote: merge queue unavailable' 'fatal: authentication failed'; do
  rm -f "$tmp/pushed" "$tmp/edited"
  if bash -euo pipefail -c 'source "$1"; decision="$(manifest_pr_writer_push example/repo automation/buck2-products-manifest)"; touch "$tmp/edited"' \
    bash "$helper" > "$tmp/push-stdout" 2> "$tmp/push-stderr"; then
    echo 'push error unexpectedly accepted' >&2
    exit 1
  fi
  test -e "$tmp/pushed"
  test ! -e "$tmp/edited"
  [[ "$(cat "$tmp/push-stderr")" == *"$push_output"* ]]
done
echo 'manifest-pr-decide: 15 decisions, API/healing warnings, writer guards, and queued push checks passed'
