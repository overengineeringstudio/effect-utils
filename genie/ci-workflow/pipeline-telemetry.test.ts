import { expect, test } from 'bun:test'

import ciWorkflow from '../../.github/workflows/ci.yml.genie.ts'
import {
  pipelineDevenvStepName,
  pipelineExportStepName,
  pipelineIdentityStepName,
} from '../../packages/@overeng/ci-tools/src/pipeline-job-names.ts'
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

test('generated CI contains exactly the adapter prerequisites consumed by the reporter', () => {
  const workflow = ciWorkflow.stringify({ cwd: process.cwd(), location: '' })
  const typecheck = workflow.split('\n  typecheck:\n')[1]?.split('\n  lint:\n')[0]
  expect(typecheck).toBeDefined()
  for (const name of [pipelineIdentityStepName, pipelineDevenvStepName, pipelineExportStepName]) {
    expect(typecheck!.split(`- name: ${name}`).length - 1).toBe(1)
  }
  const jobEnv = typecheck!.split('\n    env:\n')[1]?.split('\n    concurrency:')[0]
  expect(jobEnv).not.toContain('OTEL_EXPORTER_OTLP_ENDPOINT')
  expect(jobEnv).not.toContain('TS_EVIDENCE_CLIENT_ID:')
  expect(jobEnv).not.toContain('TS_EVIDENCE_AUDIENCE:')
  expect(typecheck).toContain('oauth-client-id: ${{ vars.TS_EVIDENCE_CLIENT_ID }}')
  expect(typecheck).toContain(
    'OTEL_EXPORTER_OTLP_ENDPOINT: ${{ vars.OTEL_EXPORTER_OTLP_ENDPOINT }}',
  )
})

test('GitBucket adds OIDC authority only to the same-repo PR reporter override', () => {
  const workflow = ciWorkflow.stringify({ cwd: process.cwd(), location: '' })
  const reporterJob = workflow.match(/\n  pipeline-traces:\n([\s\S]*?)(?=\n  [^\s]|$)/)?.[1]
  expect(reporterJob).toBeDefined()
  expect(reporterJob).toContain('id-token: write')
  expect(reporterJob).toContain("github.event_name == 'pull_request'")
  expect(reporterJob).toContain('github.event.pull_request.head.repo.full_name == github.repository')
  // Existing workflow-level Tailscale OIDC authority is unchanged by this cutover.
  expect(workflow).toContain('permissions:\n  contents: read\n  id-token: write')
})
