import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'

const script = `#!/usr/bin/env bash
# GitHub provider adapter: canonical identity, job-end export, attempt close.
set -euo pipefail
case "\${1:?mode required}" in
  identity)
    cd "\${GITHUB_WORKSPACE:?}"
    repo_component=\${GITHUB_REPOSITORY//\\//%2F}
    printf 'PIPELINE_RUN_ID=ci/github/%s/%s/%s\\n' "$repo_component" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" >> "$GITHUB_ENV"
    printf 'PIPELINE_JOB_KEY=%s\\nPIPELINE_TASK_KEY=%s\\nPIPELINE_MATRIX_RUNNER=%s\\n' "\${JOB_KEY:?}" "$JOB_KEY" "\${MATRIX_VALUE:-}" >> "$GITHUB_ENV"
    printf 'PIPELINE_EXPORT_OWNER=adapter\\nCI_PROVIDER=github\\nPIPELINE_REPOSITORY=%s\\nPIPELINE_EVENT=%s\\n' "$GITHUB_REPOSITORY" "$GITHUB_EVENT_NAME" >> "$GITHUB_ENV"
    printf 'VCS_CHANGE_ID=%s\\nPIPELINE_FORK=%s\\n' "\${PR_NUMBER:-}" "\${PR_FORK:-false}" >> "$GITHUB_ENV"
    if [ "\${PR_FORK:-false}" = true ]; then echo 'PIPELINE_TRUSTED=false' >> "$GITHUB_ENV"; else echo 'PIPELINE_TRUSTED=true' >> "$GITHUB_ENV"; fi
    merge=$(git rev-parse HEAD)
    base=$(git rev-parse --verify 'HEAD^1^{commit}' 2>/dev/null || printf '%s' "$merge")
    printf 'BUCK2_VCS_MERGE_REVISION=%s\\nVCS_REF_BASE_REVISION=%s\\nVCS_REF_HEAD_REVISION=%s\\n' "$merge" "$base" "\${PR_HEAD:-$merge}" >> "$GITHUB_ENV"
    ;;
  export)
    cd "\${GITHUB_WORKSPACE:-$PWD}"
    if [ -z "\${PIPELINE_RUN_ID:-}" ] || [ -z "\${PIPELINE_JOB_KEY:-}" ] || [ -z "\${DEVENV_BIN:-}" ]; then echo 'Pipeline: no task identity; skipping export'; exit 0; fi
    "$DEVENV_BIN" shell -- bash -c '
      set -euo pipefail
      args=()
      if [ -n "\${PIPELINE_MATRIX_RUNNER:-}" ]; then args+=("runner=$PIPELINE_MATRIX_RUNNER"); fi
      read -r trace_assignment root_assignment <<< "$(otel-span pipeline-derive "$PIPELINE_RUN_ID" "$PIPELINE_JOB_KEY" "\${args[@]}")"
      spool="$PWD/.devenv/otel/run-records/\${trace_assignment#trace=}-\${root_assignment#root=}"
      if [ -d "$spool" ]; then
        otel-span pipeline-export --spool "$spool" || echo "Warning: OTLP chunks retained in $spool" >&2
      fi
    '
    ;;
  close)
    spool="\${RUNNER_TEMP:-/tmp}/pipeline-attempt-close-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
    mkdir -p "$spool/spans" "$spool/buck2" "$spool/pending"
    export PIPELINE_SPOOL_DIR="$spool"
    bun genie/ci-scripts/pipeline-attempt-close.ts || echo 'Warning: attempt-close Jobs API unavailable' >&2
    otel-span pipeline-export --spool "$spool" || echo 'Warning: attempt-close OTLP pending locally' >&2
    ;;
  *) echo 'Unknown pipeline adapter mode' >&2; exit 2 ;;
esac
`

export default createGenieOutput({ data: script, stringify: () => script })
