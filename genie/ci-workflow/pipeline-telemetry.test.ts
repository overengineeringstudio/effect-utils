import { expect, test } from 'bun:test'

import ciWorkflow from '../../.github/workflows/ci.yml.genie.ts'
import { withPipelineTelemetry } from './pipeline-telemetry.ts'

test('each task step in a job shares the pipeline run prefix', () => {
  const jobs = withPipelineTelemetry({
    typecheck: {
      'runs-on': 'ubuntu-latest',
      steps: [
        { uses: 'actions/checkout@v6' },
        { name: 'OTel tests', run: 'devenv tasks run otel:test' },
        { name: 'Buck checks', run: 'devenv tasks run buck2:quick', env: { EXISTING: 'yes' } },
        { name: 'Report', run: 'echo complete' },
      ],
    },
  })
  const steps = jobs.typecheck!.steps
  const taskSteps = steps.filter((step) => 'run' in step && step.run?.includes('tasks run '))
  expect(taskSteps).toHaveLength(2)
  for (const step of taskSteps) {
    expect('env' in step && step.env?.PIPELINE_RUN_PREFIX).toContain('otel-span pipeline-run')
  }
  expect('env' in taskSteps[1]! && taskSteps[1]!.env?.EXISTING).toBe('yes')
  const exports = steps.filter(
    (step) => 'run' in step && step.run?.includes('evidence-job.sh export'),
  )
  expect(exports).toHaveLength(1)
  expect(exports[0]).toMatchObject({
    if: '${{ always() }}',
    run: "bash genie/ci-scripts/evidence-job.sh export '${{ job.status }}' || true",
  })
})

test('GitBucket adds OIDC authority only to the same-repo PR reporter override', () => {
  const workflow = ciWorkflow.stringify({ cwd: process.cwd(), location: '' })
  const reporterJob = workflow.match(/\n  pipeline-traces:\n([\s\S]*?)(?=\n  [^\s]|$)/)?.[1]
  expect(reporterJob).toBeDefined()
  expect(reporterJob).toContain('id-token: write')
  expect(reporterJob).toContain("github.event_name == 'pull_request'")
  expect(reporterJob).toContain(
    'github.event.pull_request.head.repo.full_name == github.repository',
  )
  // Existing workflow-level Tailscale OIDC authority is unchanged by this cutover.
  expect(workflow).toContain('permissions:\n  contents: read\n  id-token: write')
})

test('Playwright jobs capture network events only during tests and upload failure evidence', () => {
  for (const packageName of ['utils', 'tui-react'] as const) {
    const steps = ciWorkflow.data.jobs[`test-playwright-${packageName}`]!.steps
    const testStepIndex = steps.findIndex(
      (step) => 'name' in step && step.name === `${packageName === 'utils' ? 'Utils' : 'TUI React'} Playwright tests`,
    )
    const testStep = steps[testStepIndex]!
    expect('run' in testStep && testStep.run).toContain('TZ=UTC ip -ts monitor link address route')
    expect('run' in testStep && testStep.run).toContain('trap stop_network_monitor EXIT')
    expect('run' in testStep && testStep.run).toContain('wait "$network_monitor_pid"')
    expect('run' in testStep && testStep.run).toContain(
      `network_dir="packages/@overeng/${packageName}/test-results/network"`,
    )
    expect(steps[testStepIndex + 1]).toMatchObject({
      name: 'Upload Playwright failure evidence',
      if: 'failure()',
      uses: 'actions/upload-artifact@v4',
      with: {
        name: `playwright-test-results-${packageName}-run-\${{ github.run_id }}-attempt-\${{ github.run_attempt }}`,
        path: `packages/@overeng/${packageName}/test-results/`,
        'retention-days': 14,
      },
    })
    const tailnetStepIndex = steps.findIndex(
      (step) => 'uses' in step && step.uses === 'tailscale/github-action@v4',
    )
    expect(tailnetStepIndex).toBeGreaterThan(testStepIndex + 1)
  }
})
