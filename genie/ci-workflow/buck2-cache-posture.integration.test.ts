import { describe, expect, it } from 'bun:test'

type GeneratedWorkflow = {
  env?: Record<string, string>
  jobs: Record<
    string,
    {
      if?: string
      'runs-on': string | string[]
      env?: Record<string, string>
      steps: Array<{ env?: Record<string, string>; run?: string }>
    }
  >
}

const readWorkflow = async (filename = 'ci.yml'): Promise<GeneratedWorkflow> =>
  Bun.YAML.parse(
    await Bun.file(new URL(`../../.github/workflows/${filename}`, import.meta.url)).text(),
  ) as GeneratedWorkflow

const writerId = 'trusted-buck2-remote-cache-proof'
const writerSecret = 'secrets.BUCK2_PUBLIC_CACHE_WRITE_AUTH'

// The checked-in guard uses the JavaScript-compatible subset of GitHub expressions.
const evaluateExpression = (
  guard: string,
  eventName: string,
  ref: string,
  baselineRef = '',
): unknown => {
  const expression = guard.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')
  return new Function('github', 'inputs', `return (${expression})`)(
    { event_name: eventName, ref },
    { measurement_baseline_ref: baselineRef },
  )
}

describe('generated CI Buck2 cache policy', () => {
  it('explicitly assigns exactly one writer, one inert job, and readers everywhere else', async () => {
    const workflow = await readWorkflow()
    expect(workflow.jobs).toHaveProperty(writerId)
    expect(workflow.jobs).toHaveProperty('pr-a-inert-buck')
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (id === 'devenv-perf') {
        const noRemote = job.env!.BUCK2_NO_REMOTE_CACHE!
        expect(evaluateExpression(noRemote, 'workflow_dispatch', 'refs/heads/main')).toBe('0')
        expect(
          evaluateExpression(noRemote, 'workflow_dispatch', 'refs/heads/main', 'older-commit'),
        ).toBe('1')
      } else {
        expect(job.env?.BUCK2_NO_REMOTE_CACHE).toBe(id === 'pr-a-inert-buck' ? '1' : '0')
      }
      expect(job.env?.BUCK2_PUBLIC_CACHE_READ_ONLY).toBe(id === writerId ? '0' : '1')
      // A step cannot override the declared job policy to gain write authority.
      for (const step of job.steps) {
        if (step.env?.BUCK2_NO_REMOTE_CACHE !== undefined)
          expect(job.env?.BUCK2_NO_REMOTE_CACHE).toBe(step.env.BUCK2_NO_REMOTE_CACHE)
        if (step.env?.BUCK2_PUBLIC_CACHE_READ_ONLY !== undefined)
          expect(job.env?.BUCK2_PUBLIC_CACHE_READ_ONLY).toBe(step.env.BUCK2_PUBLIC_CACHE_READ_ONLY)
      }
    }
  })

  it('admits the writer only for main push and manual runs on the deployed Namespace runner', async () => {
    const workflow = await readWorkflow()
    const writer = workflow.jobs[writerId]!
    expect(writer['runs-on']).toEqual([
      'namespace-profile-linux-x86-64',
      'namespace-features:github.run-id=${{ github.run_id }}',
    ])
    expect(typeof writer.if).toBe('string')
    const guard = writer.if!
    const events = ['push', 'workflow_dispatch', 'pull_request', 'pull_request_target', 'schedule']
    for (const eventName of events) {
      for (const ref of ['refs/heads/main', 'refs/heads/feature', 'refs/pull/123/merge']) {
        expect(Boolean(evaluateExpression(guard, eventName, ref))).toBe(
          ref === 'refs/heads/main' && (eventName === 'push' || eventName === 'workflow_dispatch'),
        )
      }
    }
    expect(
      Boolean(evaluateExpression(guard, 'workflow_dispatch', 'refs/heads/main', 'older-commit')),
    ).toBe(false)
  })

  it('keeps write credentials confined to the writer proof step, never reader jobs or ambient env', async () => {
    const workflow = await readWorkflow()
    expect(JSON.stringify(workflow.env ?? {})).not.toContain(writerSecret)
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(job.env).not.toHaveProperty('BUCK2_PUBLIC_CACHE_WRITE_AUTH')
      expect(job.env).not.toHaveProperty('BUCK2_CACHE_WRITE_BASIC_AUTH')
      expect(JSON.stringify(job.env ?? {})).not.toContain(writerSecret)
      if (id !== writerId) {
        expect(JSON.stringify(job)).not.toContain(writerSecret)
        for (const step of job.steps) {
          expect(step.env ?? {}).not.toHaveProperty('BUCK2_PUBLIC_CACHE_WRITE_AUTH')
          expect(step.env ?? {}).not.toHaveProperty('BUCK2_CACHE_WRITE_BASIC_AUTH')
        }
      }
    }
    const credentialSteps = workflow.jobs[writerId]!.steps.filter(
      (step) => step.env?.BUCK2_PUBLIC_CACHE_WRITE_AUTH !== undefined,
    )
    expect(credentialSteps.map((step) => step.env?.BUCK2_PUBLIC_CACHE_WRITE_AUTH)).toEqual([
      '${{ secrets.BUCK2_PUBLIC_CACHE_WRITE_AUTH }}',
    ])
  })

  it('keeps the standalone build and Storybook workflows credential-free Buck readers', async () => {
    for (const filename of [
      'compiled-products.yml',
      'storybook-plays.yml',
      'storybook-preview-build.yml',
    ]) {
      const workflow = await readWorkflow(filename)
      for (const job of Object.values(workflow.jobs)) {
        expect(job.env?.BUCK2_NO_REMOTE_CACHE).toBe('0')
        expect(job.env?.BUCK2_PUBLIC_CACHE_READ_ONLY).toBe('1')
        expect(JSON.stringify(job)).not.toContain(writerSecret)
      }
    }
  })
})
