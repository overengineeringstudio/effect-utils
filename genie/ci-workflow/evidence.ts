import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'

// GitHub-specific expressions and credentials stop here; the task runner sees PIPELINE_*.
type Job = GitHubWorkflowArgs['jobs'][string]
export const evidenceMode = "(github.event_name == 'workflow_dispatch' && inputs.evidence_mode || vars.CI_EVIDENCE_MODE)"
export const evidenceEnabled = `${evidenceMode} == 'seal' || ${evidenceMode} == 'upload'`
const script = 'bash genie/ci-scripts/evidence-job.sh'
const uploadUrl = 'https://buck2-evidence-upload-dev3.tail8108.ts.net/'

const joinTailnetStep = {
  if: "\${{ env.EVIDENCE_MODE == 'upload' && env.PIPELINE_TRUSTED == 'true' && env.TS_EVIDENCE_CLIENT_ID != '' && env.TS_EVIDENCE_AUDIENCE != '' }}",
  uses: 'tailscale/github-action@v4',
  'continue-on-error': true,
  with: {
    'oauth-client-id': '${{ env.TS_EVIDENCE_CLIENT_ID }}',
    audience: '${{ env.TS_EVIDENCE_AUDIENCE }}',
    tags: 'tag:ci-buck2-evidence',
  },
} as const

export const withGitHubEvidence = (jobs: Record<string, Job>): Record<string, Job> =>
  Object.fromEntries(Object.entries(jobs).map(([jobId, job]) => {
    const steps = [...job.steps]
    const checkout = steps.findLastIndex((step) => 'uses' in step && step.uses?.startsWith('actions/checkout@'))
    if (checkout < 0) return [jobId, job]
    const matrix = job.strategy !== undefined && 'matrix' in job.strategy
    // The merge commit's first parent must be locally available even with fresh checkout.
    const checkoutStep = steps[checkout]
    steps[checkout] = { ...checkoutStep, with: {
      ...(checkoutStep !== undefined && 'with' in checkoutStep && typeof checkoutStep.with === 'object' && checkoutStep.with !== null ? checkoutStep.with : {}),
      'fetch-depth': 2,
    } }
    steps.splice(checkout + 1, 0, {
      name: 'Prepare provider-neutral pipeline identity',
      if: "\${{ env.EVIDENCE_MODE == 'seal' || env.EVIDENCE_MODE == 'upload' }}",
      shell: 'bash',
      env: {
        JOB_KEY: jobId,
        MATRIX_VALUE: matrix ? '${{ matrix.runner }}' : '',
        PR_HEAD: '${{ github.event.pull_request.head.sha }}',
        PR_NUMBER: '${{ github.event.pull_request.number }}',
        PR_FORK: "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}",
      },
      run: `${script} identity`,
    }, joinTailnetStep)
    const taskIndex = steps.findLastIndex((step) => 'run' in step && typeof step.run === 'string' && step.run.includes('tasks run '))
    if (taskIndex >= 0) {
      const taskStep = steps[taskIndex]
      steps[taskIndex] = { ...taskStep, env: {
        ...('env' in taskStep ? taskStep.env : {}),
        PIPELINE_RUN_PREFIX: "\${{ (env.EVIDENCE_MODE == 'seal' || env.EVIDENCE_MODE == 'upload') && format('{0} shell -- otel-span pipeline-run --', env.DEVENV_BIN) || '' }}",
      } }
    }
    steps.push({
      name: 'Seal and publish pipeline evidence',
      if: "\${{ always() && (env.EVIDENCE_MODE == 'seal' || env.EVIDENCE_MODE == 'upload') }}",
      shell: 'bash',
      env: { BUCK2_EVIDENCE_UPLOAD_URL: uploadUrl },
      run: `${script} seal || true`,
    })
    return [jobId, {
      ...job,
      permissions: { ...(typeof job.permissions === 'object' && job.permissions !== null ? job.permissions : {}), 'id-token': 'write' },
      env: { ...job.env, EVIDENCE_MODE: `\${{ ${evidenceMode} }}`, TS_EVIDENCE_CLIENT_ID: '${{ vars.TS_EVIDENCE_CLIENT_ID }}', TS_EVIDENCE_AUDIENCE: '${{ vars.TS_EVIDENCE_AUDIENCE }}' },
      steps,
    }]
  }))

export const evidenceCloseJob = (jobs: Record<string, Job>): Job => ({
  'runs-on': 'ubuntu-latest',
  needs: Object.keys(jobs),
  if: `\${{ always() && (${evidenceEnabled}) }}`,
  permissions: { contents: 'read', 'id-token': 'write' },
  env: { EVIDENCE_MODE: `\${{ ${evidenceMode} }}`, TS_EVIDENCE_CLIENT_ID: '${{ vars.TS_EVIDENCE_CLIENT_ID }}', TS_EVIDENCE_AUDIENCE: '${{ vars.TS_EVIDENCE_AUDIENCE }}' },
  steps: [
    { uses: 'actions/checkout@v6', with: { 'persist-credentials': false } },
    { name: 'Prepare Nix', uses: 'cachix/install-nix-action@v31' },
    joinTailnetStep,
    { name: 'Close pipeline attempt', shell: 'bash', env: {
      NEEDS_JSON: '${{ toJSON(needs) }}',
      EXPECTED_KEYS_JSON: JSON.stringify(Object.entries(jobs).flatMap(([jobId, job]) => {
        const matrix = job.strategy !== undefined && 'matrix' in job.strategy ? job.strategy.matrix : undefined
        if (matrix === undefined || typeof matrix !== 'object' || !('runner' in matrix) || !Array.isArray(matrix.runner)) {
          return [{ job: jobId, key: jobId }]
        }
        return matrix.runner.flatMap((runner) => typeof runner === 'string' ? [{ job: jobId, key: `${jobId}[runner=${runner}]` }] : [])
      })),
      BUCK2_EVIDENCE_UPLOAD_URL: uploadUrl,
    }, run: `${script} close || true` },
  ],
})
