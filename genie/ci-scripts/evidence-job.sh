#!/usr/bin/env bash
# Generated file - DO NOT EDIT
# Source: evidence-job.sh.genie.ts

# GitHub adapter: translate provider fields once, then invoke provider-neutral tools.
set -euo pipefail
case "${1:?mode required}" in
  identity)
    cd "${GITHUB_WORKSPACE:?}"
    repo_component=${GITHUB_REPOSITORY//\//%2F}
    printf 'PIPELINE_RUN_ID=ci/github/%s/%s/%s\n' "$repo_component" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" >> "$GITHUB_ENV"
    printf 'PIPELINE_SEAL_OWNER=adapter\n' >> "$GITHUB_ENV"
    job_key="${JOB_KEY:?}"
    if [ -n "${MATRIX_VALUE:-}" ]; then job_key="$job_key[runner=$MATRIX_VALUE]"; fi
    printf 'PIPELINE_TASK_KEY=%s\n' "$job_key" >> "$GITHUB_ENV"
    printf 'PIPELINE_REPOSITORY=%s\nPIPELINE_EVENT=%s\n' "$GITHUB_REPOSITORY" "$GITHUB_EVENT_NAME" >> "$GITHUB_ENV"
    printf 'VCS_CHANGE_ID=%s\nPIPELINE_FORK=%s\n' "${PR_NUMBER:-}" "${PR_FORK:-false}" >> "$GITHUB_ENV"
    if [ "${PR_FORK:-false}" = true ]; then echo 'PIPELINE_TRUSTED=false' >> "$GITHUB_ENV"; else echo 'PIPELINE_TRUSTED=true' >> "$GITHUB_ENV"; fi
    merge=$(git rev-parse HEAD)
    base=$(git rev-parse --verify 'HEAD^1^{commit}' 2>/dev/null || printf '%s' "$merge")
    printf 'BUCK2_VCS_MERGE_REVISION=%s\nVCS_REF_BASE_REVISION=%s\nVCS_REF_HEAD_REVISION=%s\n' "$merge" "$base" "${PR_HEAD:-$merge}" >> "$GITHUB_ENV"
    ;;
  seal)
    cd "${GITHUB_WORKSPACE:-$PWD}"
    if [ -z "${PIPELINE_RUN_ID:-}" ] || [ -z "${PIPELINE_TASK_KEY:-}" ] || [ -z "${DEVENV_BIN:-}" ]; then echo 'Evidence: no task setup; skipping'; exit 0; fi
    "$DEVENV_BIN" shell -- bash -c '
      set -euo pipefail
      read -r trace_assignment _ job_assignment <<< "$(otel-span pipeline-derive "$PIPELINE_RUN_ID" "$PIPELINE_TASK_KEY")"
      spool="$PWD/.devenv/otel/run-records/${trace_assignment#trace=}-${job_assignment#job=}"
      digest=$(buck2-evidence seal --spool "$spool" --run-id "$PIPELINE_RUN_ID" --task-key "$PIPELINE_TASK_KEY") || { echo "Warning: evidence seal failed for $PIPELINE_TASK_KEY" >&2; exit 0; }
      run_key=$(printf "%s" "$PIPELINE_RUN_ID" | jq -sRr @uri)
      if [ -n "${BUCK2_EVIDENCE_RESOLVER_URL:-}" ]; then
        resolver="${BUCK2_EVIDENCE_RESOLVER_URL%/}"
        printf "\n### Pipeline evidence\n\n- [Run](%s/run/%s)\n- [Trace](%s/t/%s)\n- Sealed record: %s\n" "$resolver" "$run_key" "$resolver" "${trace_assignment#trace=}" "$digest" >> "$GITHUB_STEP_SUMMARY"
        printf "Pipeline evidence sealed: %s\nRun: %s/run/%s\nTrace: %s/t/%s\n" "$digest" "$resolver" "$run_key" "$resolver" "${trace_assignment#trace=}"
      else
        printf "\n### Pipeline evidence\n\n- Sealed record: %s\n" "$digest" >> "$GITHUB_STEP_SUMMARY"
        printf "Pipeline evidence sealed: %s\n" "$digest"
      fi
      if [ "${EVIDENCE_MODE:-}" = upload ]; then
        if [ "${PIPELINE_TRUSTED:-}" != true ] || [ -z "${BUCK2_EVIDENCE_UPLOAD_URL:-}" ] || ! tailscale status >/dev/null 2>&1; then
          echo "Warning: evidence sealed locally; trusted upload transport unavailable" >&2
        elif receipt=$(buck2-evidence upload --spool "$spool" --url "$BUCK2_EVIDENCE_UPLOAD_URL"); then
          case "$receipt" in
            uploaded\ sha256:*) echo "$receipt" ;;
            *) echo "Warning: evidence not uploaded: $receipt" >&2 ;;
          esac
        else
          echo "Warning: evidence upload failed; sealed record remains in spool" >&2
        fi
      fi
    '
    ;;
  close)
    repo_component=${GITHUB_REPOSITORY//\//%2F}
    run_id="ci/github/$repo_component/$GITHUB_RUN_ID/$GITHUB_RUN_ATTEMPT"
    spool="${RUNNER_TEMP:-/tmp}/buck2-evidence-close"
    mkdir -p "$spool"
    jq -cn --argjson expected "$EXPECTED_KEYS_JSON" --argjson needs "$NEEDS_JSON" '$expected | map({key: .key, conclusion: ($needs[.job].result // "skipped")})' > "$spool/jobs.json"
    cli="${BUCK2_EVIDENCE_CLI:?evidence uploader was not prepared}"
    "$cli" seal-close --spool "$spool" --run-id "$run_id" --repository "$GITHUB_REPOSITORY" --jobs-json "$spool/jobs.json"
    if [ "${EVIDENCE_MODE:-}" = upload ]; then
      if [ "${PIPELINE_TRUSTED:-}" != true ] || [ -z "${BUCK2_EVIDENCE_UPLOAD_URL:-}" ] || ! tailscale status >/dev/null 2>&1; then
        echo "Warning: attempt-close sealed locally; trusted upload transport unavailable" >&2
      elif receipt=$("$cli" upload --spool "$spool" --url "$BUCK2_EVIDENCE_UPLOAD_URL"); then
        case "$receipt" in
          uploaded\ sha256:*) echo "$receipt" ;;
          *) echo "Warning: attempt-close not uploaded: $receipt" >&2 ;;
        esac
      else
        echo "Warning: attempt-close upload failed; sealed record remains in spool" >&2
      fi
    fi
    ;;
  *) echo 'Unknown evidence adapter mode' >&2; exit 2 ;;
esac
