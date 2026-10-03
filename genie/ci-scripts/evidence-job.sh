#!/usr/bin/env bash
# GitHub provider adapter: canonical identity, job-end export, attempt close.
set -euo pipefail
timestamp_ns() {
  local value seconds
  value=$(python3 -c 'import time; print(time.time_ns())' 2>/dev/null) || value=
  if [[ $value =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return
  fi
  seconds=$(date +%s 2>/dev/null) || seconds=
  [[ $seconds =~ ^[0-9]+$ ]] || seconds=0
  printf '%s000000000\n' "$seconds"
}
case "${1:?mode required}" in
  identity)
    cd "${GITHUB_WORKSPACE:?}"
    repo_component=${GITHUB_REPOSITORY//\//%2F}
    printf 'PIPELINE_JOB_START_NS=%s\n' "$(timestamp_ns)" >> "$GITHUB_ENV"
    printf 'PIPELINE_RUN_ID=ci/github/%s/%s/%s\n' "$repo_component" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" >> "$GITHUB_ENV"
    printf 'PIPELINE_JOB_KEY=%s\nPIPELINE_TASK_KEY=%s\nPIPELINE_MATRIX_RUNNER=%s\n' "${JOB_KEY:?}" "$JOB_KEY" "${MATRIX_VALUE:-}" >> "$GITHUB_ENV"
    printf 'PIPELINE_EXPORT_OWNER=adapter\nCI_PROVIDER=github\nPIPELINE_REPOSITORY=%s\nPIPELINE_EVENT=%s\n' "$GITHUB_REPOSITORY" "$GITHUB_EVENT_NAME" >> "$GITHUB_ENV"
    printf 'VCS_CHANGE_ID=%s\nPIPELINE_FORK=%s\n' "${PR_NUMBER:-}" "${PR_FORK:-false}" >> "$GITHUB_ENV"
    if [ "${PR_FORK:-false}" = true ]; then echo 'PIPELINE_TRUSTED=false' >> "$GITHUB_ENV"; else echo 'PIPELINE_TRUSTED=true' >> "$GITHUB_ENV"; fi
    merge=$(git rev-parse HEAD)
    base=$(git rev-parse --verify 'HEAD^1^{commit}' 2>/dev/null || printf '%s' "$merge")
    printf 'BUCK2_VCS_MERGE_REVISION=%s\nVCS_REF_BASE_REVISION=%s\nVCS_REF_HEAD_REVISION=%s\n' "$merge" "$base" "${PR_HEAD:-$merge}" >> "$GITHUB_ENV"
    ;;
  export)
    export PIPELINE_JOB_STATUS="${2:?job status required}"
    cd "${GITHUB_WORKSPACE:-$PWD}"
    if [ -z "${PIPELINE_RUN_ID:-}" ] || [ -z "${PIPELINE_JOB_KEY:-}" ] || [ -z "${DEVENV_BIN:-}" ]; then echo 'Pipeline: no task identity; skipping export'; exit 0; fi
    export PIPELINE_JOB_END_NS="$(timestamp_ns)"
    "$DEVENV_BIN" shell -- bash -c '
      set -euo pipefail
      args=()
      if [ -n "${PIPELINE_MATRIX_RUNNER:-}" ]; then args+=("runner=$PIPELINE_MATRIX_RUNNER"); fi
      read -r trace_assignment root_assignment <<< "$(otel-span pipeline-derive "$PIPELINE_RUN_ID" "$PIPELINE_JOB_KEY" "${args[@]}")"
      spool="$PWD/.devenv/otel/run-records/${trace_assignment#trace=}-${root_assignment#root=}"
      mkdir -p "$spool/spans" "$spool/buck2" "$spool/pending"
      export OTEL_SPAN_SPOOL_DIR="$spool/spans" OTEL_SPOOL_MULTI_WRITER=1
      status=error
      if [ "${PIPELINE_JOB_STATUS:-}" = success ]; then status=ok; fi
      case "$PIPELINE_JOB_STATUS" in
        success|failure) result=$PIPELINE_JOB_STATUS ;;
        cancelled) result=cancellation ;;
        skipped) result=skip ;;
        timed_out) result=timeout ;;
        *) result=error ;;
      esac
      attrs=()
      for entry in "vcs.provider.name:${CI_PROVIDER:-}" "vcs.change.id:${VCS_CHANGE_ID:-}" "vcs.ref.head.revision:${VCS_REF_HEAD_REVISION:-}" "vcs.ref.base.revision:${VCS_REF_BASE_REVISION:-}" "buck2.vcs.merge.revision:${BUCK2_VCS_MERGE_REVISION:-}"; do
        if [ -n "${entry#*:}" ]; then attrs+=(--attr-string "${entry/:/=}"); fi
      done
      if [ "${PIPELINE_FORK:-}" = true ] || [ "${PIPELINE_FORK:-}" = false ]; then attrs+=(--attr-bool "buck2.vcs.change.is_fork=$PIPELINE_FORK"); fi
      otel-span emit-span effect-utils-devenv cicd.pipeline.job \
        --trace-id "${trace_assignment#trace=}" --span-id "${root_assignment#root=}" \
        --start-time-ns "${PIPELINE_JOB_START_NS:?}" --end-time-ns "${PIPELINE_JOB_END_NS:?}" \
        --status-code "$status" --attr-string "cicd.pipeline.run.id=$PIPELINE_RUN_ID" \
        --attr-string "cicd.pipeline.job.key=$PIPELINE_JOB_KEY" \
        --attr-string "cicd.pipeline.task.run.result=$result" "${attrs[@]}"
      otel-span pipeline-export --spool "$spool" || echo "Warning: OTLP chunks retained in $spool" >&2
    '
    ;;
  close)
    spool="${RUNNER_TEMP:-/tmp}/pipeline-attempt-close-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
    mkdir -p "$spool/spans" "$spool/buck2" "$spool/pending"
    export PIPELINE_SPOOL_DIR="$spool"
    bun genie/ci-scripts/pipeline-attempt-close.ts || echo 'Warning: attempt-close Jobs API unavailable' >&2
    otel-span pipeline-export --spool "$spool" || echo 'Warning: attempt-close OTLP pending locally' >&2
    ;;
  *) echo 'Unknown pipeline adapter mode' >&2; exit 2 ;;
esac
