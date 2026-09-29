import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'

type Job = GitHubWorkflowArgs['jobs'][string]
const script = 'bash genie/ci-scripts/evidence-job.sh'

const joinTailnetStep = {
  if: "${{ always() && env.CI_EVIDENCE_MODE == 'upload' && env.PIPELINE_TRUSTED == 'true' && env.TS_EVIDENCE_CLIENT_ID != '' && env.TS_EVIDENCE_AUDIENCE != '' }}",
  uses: 'tailscale/github-action@v4',
  'continue-on-error': true,
  with: {
    'oauth-client-id': '${{ env.TS_EVIDENCE_CLIENT_ID }}',
    audience: '${{ env.TS_EVIDENCE_AUDIENCE }}',
    tags: 'tag:ci-buck2-evidence',
    args: '--accept-dns=true',
  },
} as const

export const withPipelineTelemetry = (jobs: Record<string, Job>): Record<string, Job> =>
  Object.fromEntries(Object.entries(jobs).map(([jobId, job]) => {
    const steps = [...job.steps]
    const checkout = steps.findLastIndex((step) => 'uses' in step && step.uses?.startsWith('actions/checkout@'))
    if (checkout < 0) return [jobId, job]
    const matrix = job.strategy !== undefined && 'matrix' in job.strategy
    steps.splice(checkout + 1, 0, {
      name: 'Prepare pipeline job identity',
      shell: 'bash',
      env: {
        JOB_KEY: jobId,
        MATRIX_VALUE: matrix ? '${{ matrix.runner }}' : '',
        PR_HEAD: '${{ github.event.pull_request.head.sha }}',
        PR_NUMBER: '${{ github.event.pull_request.number }}',
        PR_FORK: "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}",
      },
      run: `${script} identity`,
    })
    const taskIndex = steps.findLastIndex((step) => 'run' in step && typeof step.run === 'string' && step.run.includes('tasks run '))
    if (taskIndex >= 0) {
      const taskStep = steps[taskIndex]!
      steps[taskIndex] = {
        ...taskStep,
        env: {
          ...('env' in taskStep ? taskStep.env : {}),
          PIPELINE_RUN_PREFIX: '${{ format(\'{0} shell -- otel-span pipeline-run --\', env.DEVENV_BIN) }}',
        },
      }
    }
    // Never change build DNS/routes: join only after all build and span work.
    steps.push(joinTailnetStep, {
      name: 'Export completed job trace',
      if: '${{ always() }}',
      shell: 'bash',
      'continue-on-error': true,
      run: `${script} export || true`,
    })
    return [jobId, {
      ...job,
      permissions: {
        contents: 'read',
        ...(typeof job.permissions === 'object' && job.permissions !== null ? job.permissions : {}),
        'id-token': 'write',
      },
      env: {
        ...job.env,
        CI_EVIDENCE_MODE: '${{ vars.CI_EVIDENCE_MODE }}',
        OTEL_EXPORTER_OTLP_ENDPOINT: '${{ vars.OTEL_EXPORTER_OTLP_ENDPOINT }}',
        TS_EVIDENCE_CLIENT_ID: '${{ vars.TS_EVIDENCE_CLIENT_ID }}',
        TS_EVIDENCE_AUDIENCE: '${{ vars.TS_EVIDENCE_AUDIENCE }}',
      },
      steps,
    }]
  }))

export const pipelineCloseJob = (jobs: Record<string, Job>): Job => ({
  'runs-on': 'ubuntu-latest',
  needs: Object.keys(jobs),
  if: '${{ always() }}',
  permissions: { contents: 'read', actions: 'read', 'id-token': 'write' },
  env: {
    CI_EVIDENCE_MODE: '${{ vars.CI_EVIDENCE_MODE }}',
    OTEL_EXPORTER_OTLP_ENDPOINT: '${{ vars.OTEL_EXPORTER_OTLP_ENDPOINT }}',
    PIPELINE_TRUSTED: "${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}",
    TS_EVIDENCE_CLIENT_ID: '${{ vars.TS_EVIDENCE_CLIENT_ID }}',
    TS_EVIDENCE_AUDIENCE: '${{ vars.TS_EVIDENCE_AUDIENCE }}',
  },
  steps: [
    { uses: 'actions/checkout@v6', with: { 'persist-credentials': false } },
    { name: 'Prepare Nix', uses: 'cachix/install-nix-action@v31' },
    joinTailnetStep,
    {
      name: 'Link started job roots',
      shell: 'bash',
      'continue-on-error': true,
      env: { GITHUB_TOKEN: '${{ github.token }}' },
      run: `nix shell .#bun .#otel-span .#buck2-events --command ${script} close || true`,
    },
  ],
})
