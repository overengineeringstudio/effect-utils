#!/usr/bin/env bash
set -euo pipefail
store_root="${MEGAREPO_STORE:-${RUNNER_TEMP:?}/megarepo-store/${GITHUB_RUN_ID:-local}/${GITHUB_RUN_ATTEMPT:-0}/${GITHUB_JOB:-job}}"
branch_seed="ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${GITHUB_JOB:-job}"
branch_name="$(printf '%s' "$branch_seed" | tr -c 'A-Za-z0-9_-' '_')"
branch_ref="refs/heads/$branch_name"
repo_root="$store_root/github.com/overengineeringstudio/effect-utils"
bare_repo="$repo_root/.bare"
workspace_root="$repo_root/$branch_ref"
member_root="$workspace_root/repos/effect-utils"

[ -e "$workspace_root" ] || [ -L "$workspace_root" ] || exit 0
test -f "$workspace_root/.megarepo-owned-worktree.json"
test -d "$bare_repo"
[ "$(git -C "$member_root" symbolic-ref --quiet HEAD)" = "$branch_ref" ]
[ "$(git --git-dir="$bare_repo" rev-parse --is-bare-repository)" = true ]
case "$store_root" in
  "${RUNNER_TEMP:?RUNNER_TEMP not set}"/megarepo-store/*) ;;
  *) echo "::error::refusing cleanup outside job-local runner store: $store_root" >&2; exit 1 ;;
esac

git --git-dir="$bare_repo" worktree remove --force "$member_root"
rm -rf -- "$workspace_root"
git --git-dir="$bare_repo" update-ref -d "$branch_ref"
rm -rf -- "$store_root"
