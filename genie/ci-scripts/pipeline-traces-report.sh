#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
ci_tools="${CI_TOOLS_BIN:-$(nix build .#ci-tools --no-link --print-out-paths)/bin/ci-tools}"
workflow_id="$(gh api "repos/$GH_REPO/actions/runs/$GITHUB_RUN_ID" --jq .workflow_id)"
"$ci_tools" pipeline-report collect \
  --repository "$GH_REPO" \
  --run-id "$GITHUB_RUN_ID" \
  --attempt "$GITHUB_RUN_ATTEMPT" \
  --workflow-id "$workflow_id" \
  --grafana-base-url "${GRAFANA_BASE_URL:-}" \
  --output-path "$scratch/record.jsonl" > "$scratch/collect.log"
"$ci_tools" workflow-report collect-bundle \
  --bundle-id pipeline-traces \
  --input-paths-json "[\"$scratch/record.jsonl\"]" \
  --output-path "$scratch/bundle.json"
gh api "repos/$GH_REPO/issues/$PR_NUMBER/comments?per_page=100" --paginate --slurp --jq 'add' > "$scratch/comments.json"
"$ci_tools" workflow-report render-comment-body \
  --bundle-path "$scratch/bundle.json" \
  --comments-path "$scratch/comments.json" \
  --comment-body-path "$scratch/comment.md" \
  --summary-path "$scratch/summary.md" \
  --title 'Pipeline traces' \
  --no-records-message 'Jobs API report unavailable.' \
  --state-id pipeline-traces \
  --entry-id "$GITHUB_RUN_ID/$GITHUB_RUN_ATTEMPT" \
  --entry-label "PR $PR_NUMBER run $GITHUB_RUN_ID attempt $GITHUB_RUN_ATTEMPT"
if [[ "${PIPELINE_REPORT_DRY_RUN:-0}" = 1 ]]; then
  cat "$scratch/summary.md"
  exit 0
fi
cat "$scratch/summary.md" >> "$GITHUB_STEP_SUMMARY"
"$ci_tools" workflow-report find-comment \
  --comments-path "$scratch/comments.json" \
  --comment-body-path "$scratch/comment.md" \
  --comment-id-path "$scratch/comment-id" \
  --state-id pipeline-traces
if [[ -s "$scratch/comment-id" ]]; then
  gh api --method PATCH "repos/$GH_REPO/issues/comments/$(cat "$scratch/comment-id")" --raw-field "body=$(cat "$scratch/comment.md")" > /dev/null
else
  gh api --method POST "repos/$GH_REPO/issues/$PR_NUMBER/comments" --raw-field "body=$(cat "$scratch/comment.md")" > /dev/null
fi
