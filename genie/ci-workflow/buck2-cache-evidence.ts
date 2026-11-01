import { pinnedAction } from '../../packages/@overeng/genie/src/runtime/github-workflow/action-pins.ts'

import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { coreProofDisabledJobIds } from './buck2-cache-proof-policy.ts'
import { ciJobAdmission, withCiAdmissionCleanup } from './shared.ts'

/** Mirror GitHub's existing default name; never rename required status checks. */
const evidenceJobDisplayName = ({
  jobId,
  job,
}: {
  jobId: string
  job: GitHubWorkflowArgs['jobs'][string]
}): string | undefined => {
  if (job.name !== undefined) return job.name
  if (job.strategy === undefined || !('matrix' in job.strategy)) return jobId
  const matrix = job.strategy.matrix
  // Dynamic/include-only matrices have no statically established axis order.
  // Leave their identity unknown rather than accepting a guessed matrix cell.
  if (typeof matrix !== 'object' || matrix === null) return undefined
  const axes = Object.keys(matrix).filter((axis) => axis !== 'include' && axis !== 'exclude')
  if (
    axes.length === 0 ||
    axes.some((axis) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(axis) !== true) === true
  )
    return undefined
  return `${jobId} (${axes.map((axis) => `\${{ matrix.${axis} }}`).join(', ')})`
}

/** Retain compact and complete native cache evidence independently of tailnet/OTLP delivery. */
export const withBuck2CacheEvidence = (
  jobs: GitHubWorkflowArgs['jobs'],
): GitHubWorkflowArgs['jobs'] =>
  Object.fromEntries(
    Object.entries(jobs).map(([jobId, job]) => {
      if (coreProofDisabledJobIds[jobId] === true)
        return [jobId, { ...job, env: { ...job.env, CI_BUCK2_CACHE_EVIDENCE_DISABLED: '1' } }]
      const steps = [...job.steps]
      const checkout = steps.findLastIndex(
        (step) => 'uses' in step && step.uses.startsWith('actions/checkout@'),
      )
      if (checkout < 0) return [jobId, job]
      const admission = ciJobAdmission(steps)
      const matrix = job.strategy !== undefined && 'matrix' in job.strategy
      steps.splice(Math.max(checkout, admission.after) + 1, 0, {
        name: 'Start Buck2 cache evidence window',
        shell: 'bash',
        run: [
          'set -euo pipefail',
          'marker="${CI_BUCK2_CACHE_EVIDENCE_START:?cache evidence start not declared}"',
          'mkdir -p "${marker%/*}"',
          'started_at=$(( $(date +%s) * 1000 ))',
          'source_root=""',
          'fresh_root=0',
          'if source_root=$(cd "${CI_SOURCE_ROOT:-${GITHUB_WORKSPACE:?GITHUB_WORKSPACE not set}}" && pwd -P); then',
          '  if tracked_root=$(git -C "$source_root" rev-parse --show-toplevel 2>/dev/null) &&',
          '     tracked_root=$(cd "$tracked_root" && pwd -P) &&',
          '     [ "$tracked_root" = "$source_root" ] &&',
          '     [ ! -e "$source_root/buck-out" ] && [ ! -L "$source_root/buck-out" ]; then',
          '    fresh_root=1',
          '  fi',
          'fi',
          'printf "%s\\n%s\\n%s\\n" "$started_at" "$source_root" "$fresh_root" > "$marker"',
          'printf "CI_BUCK2_CACHE_EVIDENCE_STARTED_AT=%s\\n" "$started_at" >> "$GITHUB_ENV"',
        ].join('\n'),
      })
      steps.push(
        {
          name: 'Collect Buck2 cache evidence',
          if: '${{ always() }}',
          shell: 'bash',
          env: { GITHUB_TOKEN: '${{ github.token }}' },
          'continue-on-error': true,
          run: [
            'set -euo pipefail',
            'cd "${CI_SOURCE_ROOT:-${GITHUB_WORKSPACE:?GITHUB_WORKSPACE not set}}"',
            'nix shell .#bun .#buck2 --command bash genie/ci-scripts/collect-buck2-cache-evidence.sh',
          ].join('\n'),
        },
        {
          name: 'Upload Buck2 cache evidence',
          if: '${{ always() }}',
          ...pinnedAction({ name: 'uploadArtifact' }),
          with: {
            name:
              `buck2-cache-evidence-${jobId}` +
              (matrix === true ? '-${{ strategy.job-index }}' : '') +
              '-${{ github.run_attempt }}',
            path: [
              '${{ env.CI_BUCK2_CACHE_EVIDENCE_PATH }}',
              '${{ env.CI_BUCK2_CACHE_ACTIONS_PATH }}',
              '${{ env.CI_BUCK2_CACHE_WARM99_PATH }}',
              '${{ env.CI_BUCK2_CACHE_PROOF_MANIFEST_PATH }}',
              '${{ env.CI_BUCK2_CACHE_EVIDENCE_PATH }}.shard-index.json',
              '${{ env.CI_BUCK2_CACHE_EVIDENCE_PATH }}.shards/*.json',
            ].join('\n'),
            'if-no-files-found': 'warn',
            'retention-days': 90,
          },
        },
      )
      return [
        jobId,
        {
          ...job,
          env: {
            ...job.env,
            CI_BUCK2_CACHE_EVIDENCE_PATH: '${{ github.workspace }}/tmp/buck2-cache-evidence.json',
            CI_BUCK2_CACHE_ACTIONS_PATH: '${{ github.workspace }}/tmp/buck2-cache-actions.jsonl.gz',
            CI_BUCK2_CACHE_WARM99_PATH: '${{ github.workspace }}/tmp/buck2-cache-warm99.json',
            CI_BUCK2_CACHE_PROOF_MANIFEST_PATH:
              '${{ github.workspace }}/tmp/buck2-cache-proof-manifest.json',
            CI_BUCK2_CACHE_EVIDENCE_START: '${{ github.workspace }}/tmp/buck2-cache-evidence-start',
            CI_BUCK2_CACHE_EVIDENCE_JOB: jobId,
            CI_BUCK2_CACHE_EVIDENCE_JOB_NAME: evidenceJobDisplayName({ jobId, job }),
            CI_BUCK2_CACHE_EVIDENCE_HEAD_SHA:
              '${{ github.event.pull_request.head.sha || github.sha }}',
            CI_BUCK2_CACHE_EVIDENCE_DISABLED: '0',
          },
          steps: withCiAdmissionCleanup(steps),
        },
      ]
    }),
  )
