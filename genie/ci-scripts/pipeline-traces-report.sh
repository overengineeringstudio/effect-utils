#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
ci_tools="${CI_TOOLS_BIN:-$(nix build .#ci-tools-compiled --no-link --print-out-paths)/bin/ci-tools}"
"$ci_tools" pipeline-report collect \
  --repository "$GH_REPO" \
  --run-id "$GITHUB_RUN_ID" \
  --attempt "$GITHUB_RUN_ATTEMPT" \
  --grafana-base-url "${GRAFANA_BASE_URL:-}" \
  --api-base-url "${GITHUB_API_URL:-https://api.github.com}" \
  --output-path "$scratch/record.jsonl" > "$scratch/collect.log"
"$ci_tools" workflow-report collect-bundle \
  --bundle-id pipeline-traces \
  --input-paths-json "[\"$scratch/record.jsonl\"]" \
  --output-path "$scratch/bundle.json"

# Optional image attachment contract:
# PIPELINE_TRACES_PUBLIC_ASSET_COMMAND is an executable path, never shell text.
# It receives one PNG_PATH argument and emits one public
# https://gitbucket.schickling.dev/api/get/<sha256> URL on stdout (diagnostics to stderr).
# Attachment edits the collected bundle records, preserving their canonical envelopes.
# PIPELINE_TRACES_ASSET_SSH_KEY is optional SSH private key material inherited by
# the external adapter, not a bearer token. GitBucket authorizes the GitHub user,
# not an individual key: a fresh key is independently revocable, not upload-only.
# The adapter must explicitly opt into public upload and handle SSH signing.
# When SSH key material is configured and no command override is set, use the
# checked-in PNG adapter with explicit PIPELINE_TRACES_ASSET_USERNAME.
# This script never provisions credentials or defaults to an assistant identity.
# Without an authorized adapter, leave the report unchanged (jobs-only Mermaid).
# Dry-run skips image attachment and all uploads, even if an adapter is configured.
# Diagnostics may contain credentials: retain them only in ephemeral scratch files,
# never echo raw renderer/rasterizer/uploader stderr in GitHub warnings.
# Any render/raster/upload failure retains the original report, including when
# only one upload succeeds. Rasterization uses the repo-locked resvg/font closure.
# Each PNG must be nonempty and <= 5 MiB; each adapter invocation has a 60s timeout
# (two uploads, so image publication adds at most 2 x 60s to the report step).
waterfall_stage=configuration
if [[ -z "${PIPELINE_TRACES_PUBLIC_ASSET_COMMAND:-}" && -n "${PIPELINE_TRACES_ASSET_SSH_KEY:-}" ]]; then
  PIPELINE_TRACES_PUBLIC_ASSET_COMMAND="$(dirname "${BASH_SOURCE[0]}")/pipeline-traces-upload-png.sh"
fi
attach_waterfall() {
  local rasterizer light_url dark_url theme png_size
  [[ -f "$PIPELINE_TRACES_PUBLIC_ASSET_COMMAND" && -x "$PIPELINE_TRACES_PUBLIC_ASSET_COMMAND" ]] || return 1
  waterfall_stage=report-data
  jq -e '.records[] | select(.kind == "pipeline-traces") | .data' "$scratch/bundle.json" \
    > "$scratch/report.json" 2> "$scratch/report-data.log" || return 1
  waterfall_stage=svg-render
  timeout --kill-after=5s 30s "$ci_tools" pipeline-waterfall \
    --input "$scratch/report.json" --output-dir "$scratch/waterfall" \
    > "$scratch/waterfall.log" 2>&1 || return 1
  waterfall_stage=rasterizer-build
  rasterizer="$(timeout --kill-after=5s 180s nix build .#pipeline-waterfall-rasterizer \
    --no-link --print-out-paths 2> "$scratch/rasterizer-build.log")/bin/pipeline-waterfall-rasterizer" || return 1
  for theme in light dark; do
    waterfall_stage="raster-$theme"
    timeout --kill-after=5s 30s "$rasterizer" \
      "$scratch/waterfall/$theme.svg" "$scratch/waterfall/$theme.png" \
      > "$scratch/rasterizer-$theme.log" 2>&1 || return 1
    [[ -s "$scratch/waterfall/$theme.png" ]] || return 1
    waterfall_stage="png-size-$theme"
    png_size="$(wc -c < "$scratch/waterfall/$theme.png")"
    (( png_size <= 5 * 1024 * 1024 )) || return 1
  done
  # Validate both local files before uploading either; only attach a complete pair.
  for theme in light dark; do
    waterfall_stage="upload-$theme"
    timeout --kill-after=5s 60s "$PIPELINE_TRACES_PUBLIC_ASSET_COMMAND" \
      "$scratch/waterfall/$theme.png" \
      > "$scratch/url-$theme" 2> "$scratch/upload-$theme.log" || return 1
    waterfall_stage="url-$theme"
    jq -Rse 'test("^https://gitbucket[.]schickling[.]dev/api/get/[a-f0-9]{64}\\n?$")' \
      "$scratch/url-$theme" > /dev/null 2> "$scratch/url-validation-$theme.log" || return 1
  done
  light_url="$(cat "$scratch/url-light")"
  dark_url="$(cat "$scratch/url-dark")"
  waterfall_stage=attachment
  jq --arg lightUrl "$light_url" --arg darkUrl "$dark_url" \
    '.records |= map(if .kind == "pipeline-traces" then .data.waterfall = {lightUrl: $lightUrl, darkUrl: $darkUrl} else . end)' \
    "$scratch/bundle.json" > "$scratch/bundle-with-waterfall.json" 2> "$scratch/attachment.log" || return 1
  mv "$scratch/bundle-with-waterfall.json" "$scratch/bundle.json"
}
if [[ "${PIPELINE_REPORT_DRY_RUN:-0}" != 1 && -n "${PIPELINE_TRACES_PUBLIC_ASSET_COMMAND:-}" ]]; then
  if ! attach_waterfall; then
    # Only the uploader's sanitized final line may reach the public warning, and only
    # when it exactly matches the stage/status contract; everything else stays in scratch.
    waterfall_reason=''
    upload_reason_pattern='^gitbucket-upload: (challenge|sign|verify|upload|url) (http [0-9]{3}|exit [0-9]+)$'
    if [[ "$waterfall_stage" == upload-* && -f "$scratch/$waterfall_stage.log" ]]; then
      upload_reason="$(tail -n 1 "$scratch/$waterfall_stage.log")"
      [[ "$upload_reason" =~ $upload_reason_pattern ]] && waterfall_reason=" (${upload_reason#gitbucket-upload: })"
    fi
    echo "::warning::Pipeline waterfall stage $waterfall_stage failed$waterfall_reason; retaining jobs-only Mermaid report."
  fi
fi
gh api "repos/$GH_REPO/issues/$PR_NUMBER/comments?per_page=100" --paginate --slurp | jq 'add' > "$scratch/comments.json"
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
