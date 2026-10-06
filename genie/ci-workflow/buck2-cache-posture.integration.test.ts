import { describe, expect, it } from 'bun:test'

type GeneratedWorkflow = {
  env?: Record<string, string>
  jobs: Record<
    string,
    {
      if?: string
      'runs-on': string | string[]
      env?: Record<string, string>
      steps: Array<{
        name?: string
        uses?: string
        if?: string
        env?: Record<string, string>
        run?: string
        with?: Record<string, string | number>
      }>
    }
  >
}

const readWorkflow = async (filename = 'ci.yml'): Promise<GeneratedWorkflow> =>
  Bun.YAML.parse(
    await Bun.file(new URL(`../../.github/workflows/${filename}`, import.meta.url)).text(),
  ) as GeneratedWorkflow

const writerId = 'trusted-buck2-remote-cache-proof'
const writerSecret = 'secrets.BUCK2_PUBLIC_CACHE_WRITE_AUTH'
const mainWriterReadOnly =
  "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && '0' || '1' }}"
const mainWriterSecret =
  "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && secrets.BUCK2_PUBLIC_CACHE_WRITE_AUTH || '' }}"

// The checked-in guard uses the JavaScript-compatible subset of GitHub expressions.
const evaluateExpression = (
  guard: string,
  eventName: string,
  ref: string,
  baselineRef = '',
): unknown => {
  const expression = guard.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')
  return new Function('github', 'inputs', 'secrets', `return (${expression})`)(
    { event_name: eventName, ref },
    { measurement_baseline_ref: baselineRef },
    { BUCK2_PUBLIC_CACHE_WRITE_AUTH: 'fixture-credential' },
  )
}

describe('generated CI Buck2 cache policy', () => {
  it('keeps only quality and test opportunistic writers, with all other postures unchanged', async () => {
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
      const opportunisticWriter = id === 'quality' || id === 'test'
      expect(job.env?.BUCK2_PUBLIC_CACHE_READ_ONLY).toBe(
        opportunisticWriter ? mainWriterReadOnly : id === writerId ? '0' : '1',
      )
      expect(job.env?.BUCK2_CACHE_WRITE_OPTIONAL).toBe(opportunisticWriter ? '1' : undefined)
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
    const events = [
      'push',
      'workflow_dispatch',
      'pull_request',
      'pull_request_target',
      'schedule',
      'merge_group',
    ]
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

  it('never gives merge groups or PRs write authority or a writer credential', async () => {
    const workflow = await readWorkflow()
    expect(JSON.stringify(workflow.env ?? {})).not.toContain(writerSecret)
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(job.env).not.toHaveProperty('BUCK2_PUBLIC_CACHE_WRITE_AUTH')
      expect(job.env).not.toHaveProperty('BUCK2_CACHE_WRITE_BASIC_AUTH')
      expect(JSON.stringify(job.env ?? {})).not.toContain(writerSecret)
      for (const step of job.steps) {
        expect(step.env ?? {}).not.toHaveProperty('BUCK2_CACHE_WRITE_BASIC_AUTH')
        const credential = step.env?.BUCK2_PUBLIC_CACHE_WRITE_AUTH
        if (credential === undefined) {
          expect(JSON.stringify(step)).not.toContain(writerSecret)
        } else {
          expect(credential).toBe(
            id === writerId ? '${{ secrets.BUCK2_PUBLIC_CACHE_WRITE_AUTH }}' : mainWriterSecret,
          )
          expect(id === writerId || id === 'quality' || id === 'test').toBe(true)
        }
      }
      for (const event of ['merge_group', 'pull_request', 'workflow_dispatch', 'push']) {
        for (const ref of [
          'refs/heads/main',
          'refs/heads/feature',
          'refs/heads/gh-readonly-queue/main/pr-123',
        ]) {
          if (id === writerId) {
            if (event === 'merge_group' || event === 'pull_request')
              expect(Boolean(evaluateExpression(job.if!, event, ref))).toBe(false)
            continue
          }
          const readOnly = job.env!.BUCK2_PUBLIC_CACHE_READ_ONLY!
          const effectiveReadOnly = readOnly.startsWith('${{')
            ? evaluateExpression(readOnly, event, ref)
            : readOnly
          const mainPushWriter =
            (id === 'quality' || id === 'test') && event === 'push' && ref === 'refs/heads/main'
          expect(effectiveReadOnly).toBe(mainPushWriter ? '0' : '1')
          for (const step of job.steps) {
            const credential = step.env?.BUCK2_PUBLIC_CACHE_WRITE_AUTH
            if (credential !== undefined)
              expect(evaluateExpression(credential, event, ref)).toBe(
                mainPushWriter ? 'fixture-credential' : '',
              )
          }
        }
      }
    }
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

  it('uploads both native evidence artifacts for every decorated workflow job', async () => {
    for (const filename of [
      'ci.yml',
      'compiled-products.yml',
      'storybook-plays.yml',
      'storybook-preview-build.yml',
    ]) {
      const workflow = await readWorkflow(filename)
      for (const job of Object.values(workflow.jobs)) {
        const start = job.steps.find((step) => step.name === 'Start Buck2 cache evidence window')
        if (start === undefined) continue
        expect(job.env?.CI_BUCK2_CACHE_ACTIONS_PATH).toBe(
          '${{ github.workspace }}/tmp/buck2-cache-actions.jsonl.gz',
        )
        expect(start.run).toContain('CI_BUCK2_CACHE_EVIDENCE_STARTED_AT')
        expect(start.run).toContain('[ ! -e "$source_root/buck-out" ]')
        expect(start.run).toContain('[ ! -L "$source_root/buck-out" ]')
        const uploads = job.steps.filter((step) => step.name === 'Upload Buck2 cache evidence')
        expect(uploads).toHaveLength(1)
        expect(uploads[0]?.if).toBe('${{ always() }}')
        expect(String(uploads[0]?.with?.path).trimEnd()).toBe(
          '${{ env.CI_BUCK2_CACHE_EVIDENCE_PATH }}\n${{ env.CI_BUCK2_CACHE_ACTIONS_PATH }}',
        )
        expect(uploads[0]?.with?.['retention-days']).toBe(14)
      }
    }
  })
})
