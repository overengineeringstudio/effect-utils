#!/usr/bin/env bash
# Source this helper after pushing and creating/updating the publisher PR.
manifest_pr_queue_report() {
  printf '%s\n' "$1" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}
manifest_pr_enqueue() {
  local repository="$1" pr="$2" pushed_sha="$3" snapshot files reason
  # Read files first, then re-read the head: a concurrent branch update must not
  # let an old manifest-only file list authorize a different commit.
  if ! files="$(gh api --paginate --slurp "repos/$repository/pulls/$pr/files?per_page=100")" ||
    ! snapshot="$(gh api "repos/$repository/pulls/$pr")"; then
    manifest_pr_queue_report '::error::Manifest PR queue refused: unable to read the PR and its complete diff'
    return 1
  fi
  if ! reason="$(jq -er --arg sha "$pushed_sha" --arg repository "$repository" --argjson pages "$files" '
    if .user.login != "overeng-nix-publisher[bot]" or .user.type != "Bot" then "author is not the publisher app"
    elif .head.sha != $sha or ($sha | test("^[0-9a-f]{40}$") | not) then "head differs from the pushed SHA"
    elif .draft != false then "PR is draft or draft status is unavailable"
    elif .state != "open" or .base.ref != "main" or .base.repo.full_name != $repository or .head.repo.full_name != $repository then "PR is not an open same-repository proposal against main"
    elif .changed_files != 1 or ($pages | flatten | length) != 1 then "diff is not exactly one manifest file"
    elif ($pages | flatten | .[0] | .filename != "nix/buck2-products/manifest.json" or (.previous_filename // .filename) != "nix/buck2-products/manifest.json") then "diff changes a non-manifest path"
    else "allow" end
  ' <<< "$snapshot")"; then
    manifest_pr_queue_report '::error::Manifest PR queue refused: invalid PR metadata or diff response'
    return 1
  fi
  if [ "$reason" != allow ]; then
    manifest_pr_queue_report "::error::Manifest PR queue refused: $reason"
    return 1
  fi
  # No merge strategy and no --admin: gh fails non-interactively if the base
  # does not require a merge queue. Pending checks enable auto-merge, which
  # joins that queue when ready; expectedHeadOid guards the API mutation too.
  if ! GH_PROMPT_DISABLED=1 gh pr merge "$pr" --repo "$repository" --auto --match-head-commit "$pushed_sha"; then
    manifest_pr_queue_report '::error::Manifest PR queue request failed; no fallback or merge-queue bypass attempted'
    return 1
  fi
  manifest_pr_queue_report "Manifest PR #$pr at $pushed_sha: merge queue requested (pending requirements defer entry until ready)."
}
