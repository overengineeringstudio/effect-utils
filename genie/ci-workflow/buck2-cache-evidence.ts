import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'

/** Retain compact native cache evidence independently of tailnet/OTLP delivery. */
export const withBuck2CacheEvidence = (
  jobs: GitHubWorkflowArgs['jobs'],
): GitHubWorkflowArgs['jobs'] =>
  Object.fromEntries(
    Object.entries(jobs).map(([jobId, job]) => {
      const steps = [...job.steps]
      const checkout = steps.findLastIndex(
        (step) => 'uses' in step && step.uses.startsWith('actions/checkout@'),
      )
      if (checkout < 0) return [jobId, job]
      const matrix = job.strategy !== undefined && 'matrix' in job.strategy
      steps.splice(checkout + 1, 0, {
        name: 'Start Buck2 cache evidence window',
        shell: 'bash',
        run: 'mkdir -p "${CI_BUCK2_CACHE_EVIDENCE_START%/*}"; touch "$CI_BUCK2_CACHE_EVIDENCE_START"',
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
          uses: 'actions/upload-artifact@v4',
          with: {
            name:
              `buck2-cache-evidence-${jobId}` +
              (matrix === true ? '-${{ strategy.job-index }}' : '') +
              '-${{ github.run_attempt }}',
            path: '${{ env.CI_BUCK2_CACHE_EVIDENCE_PATH }}',
            'if-no-files-found': 'warn',
            'retention-days': 14,
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
            CI_BUCK2_CACHE_EVIDENCE_START: '${{ github.workspace }}/tmp/buck2-cache-evidence-start',
            CI_BUCK2_CACHE_EVIDENCE_JOB: jobId,
            CI_BUCK2_CACHE_EVIDENCE_HEAD_SHA:
              '${{ github.event.pull_request.head.sha || github.sha }}',
            CI_BUCK2_CACHE_EVIDENCE_DISABLED:
              ['build-products', 'publish-products', 'publish-compiled-products'].includes(jobId)
                ? '1'
                : '0',
          },
          steps,
        },
      ]
    }),
  )
