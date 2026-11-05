#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/manifest-pr-decide.sh"
tmp="$(mktemp -d)"
trap 'rm -r "$tmp"' EXIT
export GITHUB_TOKEN=read-only
pins='["bootstrap"]'
now=1760000000
api_epoch=1759999999
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
api_epoch=1759913600
assert_decision other open
assert_decision main skip-no-diff
api_fail=true
assert_decision other skip-unchanged-genie 2> "$tmp/warning"
test -s "$tmp/warning"
jq '.products |= reverse' "$tmp/main" > "$tmp/reordered"
assert_decision reordered skip-no-diff
remote_fail=false
git() {
  test "$*" = 'ls-remote origin refs/heads/main'
  if "$remote_fail"; then return 1; fi
  printf 'newer\trefs/heads/main\n'
}
test "$(manifest_pr_writer_decide older 2> "$tmp/superseded")" = skip-superseded
test -s "$tmp/superseded"
test "$(manifest_pr_writer_decide newer)" = open
remote_fail=true
test "$(manifest_pr_writer_decide newer 2> "$tmp/remote-warning")" = skip-superseded
test -s "$tmp/remote-warning"
test "$(manifest_pr_heal_decide skip-recent-safety-net "$tmp/other" "$tmp/bootstrap" "$pins")" = open
test "$(manifest_pr_heal_decide skip-recent-safety-net "$tmp/other" "$tmp/main" "$pins")" = skip-recent-safety-net
test "$(manifest_pr_heal_decide skip-recent-safety-net "$tmp/other" "$tmp/missing" "$pins" 2> "$tmp/heal-warning")" = open
test -s "$tmp/heal-warning"
test "$(manifest_pr_heal_decide skip-no-diff "$tmp/main" "$tmp/bootstrap" "$pins")" = close
echo 'manifest-pr-decide: 13 decisions, API/healing warnings, and superseded checks passed'
