import { describe, expect, it } from 'bun:test'

import { standaloneCachePostureConfig } from '../../scripts/buck2-cache-posture.ts'

type GeneratedWorkflow = {
  env?: Record<string, string>
  jobs: Record<
    string,
    {
      if?: string
      env?: Record<string, string>
      steps: Array<{ env?: Record<string, string>; run?: string }>
    }
  >
}

const readWorkflow = async (filename = 'ci.yml'): Promise<GeneratedWorkflow> =>
  Bun.YAML.parse(
    await Bun.file(new URL(`../../.github/workflows/${filename}`, import.meta.url)).text(),
  ) as GeneratedWorkflow

const evaluate = (
  value: string,
  event: string,
  ref: string,
  baseRef = 'refs/heads/main',
  tested = false,
): unknown => {
  if (value.startsWith('${{') === false) return value
  const expression = value
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .replaceAll('needs.tested-tree', "needs['tested-tree']")
  return new Function(
    'github',
    'inputs',
    'secrets',
    'startsWith',
    'cancelled',
    'needs',
    `return (${expression})`,
  )(
    { event_name: event, ref, event: { merge_group: { base_ref: baseRef } } },
    { measurement_baseline_ref: '' },
    { BUCK2_PUBLIC_CACHE_WRITE_AUTH: 'fixture-credential' },
    (text: string, prefix: string) => text.startsWith(prefix),
    () => false,
    { 'tested-tree': { outputs: { tested: tested === true ? 'true' : 'false' } } },
  )
}

const writers: Record<string, true> = {
  quality: true,
  test: true,
  'test-macos': true,
  'test-playwright-utils': true,
  'test-playwright-tui-react': true,
  cargo: true,
  weaver: true,
  'test-integration-restate': true,
  'build-products': true,
  'test-storybook-plays': true,
}
const strictWriter = 'trusted-buck2-remote-cache-proof'

const scenarios = [
  { event: 'push', ref: 'refs/heads/main', base: 'refs/heads/main', trusted: true },
  {
    event: 'merge_group',
    ref: 'refs/heads/gh-readonly-queue/main/pr-123',
    base: 'refs/heads/main',
    trusted: true,
  },
  {
    event: 'merge_group',
    ref: 'refs/heads/gh-readonly-queue/main/pr-123',
    base: 'refs/heads/other',
    trusted: false,
  },
  {
    event: 'merge_group',
    ref: 'refs/heads/gh-readonly-queue/other/pr-123',
    base: 'refs/heads/main',
    trusted: false,
  },
  { event: 'merge_group', ref: 'refs/heads/main', base: 'refs/heads/main', trusted: false },
  ...['pull_request', 'pull_request_target', 'schedule', 'workflow_dispatch', 'push'].flatMap(
    (event) =>
      ['refs/pull/123/merge', 'refs/heads/feature', 'refs/heads/gh-readonly-queue/main/pr-123'].map(
        (ref) => ({ event, ref, base: 'refs/heads/main', trusted: false }),
      ),
  ),
  { event: 'pull_request', ref: 'refs/heads/main', base: 'refs/heads/main', trusted: false },
  { event: 'workflow_dispatch', ref: 'refs/heads/main', base: 'refs/heads/main', trusted: false },
]

describe('generated CI cache trust behavior', () => {
  it('enables opportunistic uploads only with a protected main or queue event and step-local credential', async () => {
    for (const filename of ['ci.yml', 'storybook-plays.yml']) {
      const workflow = await readWorkflow(filename)
      expect(JSON.stringify(workflow.env ?? {})).not.toContain(
        'secrets.BUCK2_PUBLIC_CACHE_WRITE_AUTH',
      )
      for (const [id, job] of Object.entries(workflow.jobs)) {
        expect(JSON.stringify(job.env ?? {})).not.toContain('secrets.BUCK2_PUBLIC_CACHE_WRITE_AUTH')
        if (id === strictWriter) continue
        for (const scenario of scenarios) {
          const env = Object.fromEntries(
            Object.entries(job.env ?? {})
              .filter(([key]) => key.startsWith('BUCK2_'))
              .map(([key, value]) => [
                key,
                String(evaluate(value, scenario.event, scenario.ref, scenario.base)),
              ]),
          )
          const writerSteps = job.steps.filter(
            (step) => step.env?.BUCK2_PUBLIC_CACHE_WRITE_AUTH !== undefined,
          )
          if (writers[id] === true) expect(writerSteps.length).toBeGreaterThan(0)
          for (const step of job.steps) {
            const credential = step.env?.BUCK2_PUBLIC_CACHE_WRITE_AUTH
            const supplied =
              credential === undefined
                ? ''
                : String(evaluate(credential, scenario.event, scenario.ref, scenario.base))
            expect(supplied).toBe(
              writers[id] === true && credential !== undefined && scenario.trusted === true
                ? 'fixture-credential'
                : '',
            )
          }
          // Reader policy wins even if an accidental credential reaches the resolver.
          const config = standaloneCachePostureConfig({
            current: '',
            trustedOrigin: { tier: 'private', urlPrefix: 'https://cache.example/cas/' },
            env: { ...env, BUCK2_CACHE_WRITE_BASIC_AUTH: 'fixture-credential' },
          })
          expect(config).toContain(
            `allow_cache_uploads = ${writers[id] === true && scenario.trusted === true ? 'true' : 'false'}`,
          )
          expect(env.BUCK2_CACHE_WRITE_OPTIONAL).toBe(writers[id] === true ? '1' : undefined)
        }
      }
    }
  })

  it('keeps the strict remote cache proof on main and never admits it on PR or queue events', async () => {
    const job = (await readWorkflow()).jobs[strictWriter]!
    for (const scenario of scenarios.filter(
      ({ event }) => event === 'pull_request' || event === 'merge_group',
    ))
      expect(Boolean(evaluate(job.if!, scenario.event, scenario.ref, scenario.base))).toBe(false)
    expect(job.env?.BUCK2_CACHE_WRITE_OPTIONAL).toBeUndefined()
  })

  it('skips main heavy lanes only for tested trees and still runs queues, publishers and the proof', async () => {
    const workflow = await readWorkflow()
    for (const id of Object.keys(writers).filter((id) => id !== 'test-storybook-plays')) {
      const job = workflow.jobs[id]!
      expect(Boolean(evaluate(job.if!, 'push', 'refs/heads/main', undefined, true))).toBe(false)
      expect(Boolean(evaluate(job.if!, 'push', 'refs/heads/main', undefined, false))).toBe(true)
      expect(
        Boolean(
          evaluate(
            job.if!,
            'merge_group',
            'refs/heads/gh-readonly-queue/main/pr-123',
            undefined,
            true,
          ),
        ),
      ).toBe(true)
    }
    for (const id of ['publish-products', 'deploy-storybooks', strictWriter])
      expect(
        Boolean(evaluate(workflow.jobs[id]!.if!, 'push', 'refs/heads/main', undefined, true)),
      ).toBe(true)
  })

  it('dispatches alignment after reused queue evidence without ignoring failed publication', async () => {
    const job = (await readWorkflow()).jobs['notify-alignment']!
    expect(job.needs).toContain('tested-tree')
    expect(job.needs).toContain('quality')
    const expression = job
      .if!.slice(3, -2)
      .replaceAll('needs.*.result', 'results')
      .replaceAll('needs.tested-tree', "needs['tested-tree']")
    const check = new Function(
      'github',
      'needs',
      'results',
      'contains',
      'cancelled',
      `return (${expression})`,
    )
    const run = (tested: string, quality: string, publication: string) =>
      check(
        { event_name: 'push', ref: 'refs/heads/main' },
        { quality: { result: quality }, 'tested-tree': { outputs: { tested } } },
        [quality, publication],
        (values: string[], value: string) => values.includes(value),
        () => false,
      )
    expect(run('true', 'skipped', 'success')).toBe(true)
    expect(run('false', 'success', 'success')).toBe(true)
    expect(run('false', 'skipped', 'success')).toBe(false)
    expect(run('true', 'skipped', 'failure')).toBe(false)
    expect(run('true', 'skipped', 'cancelled')).toBe(false)
  })

  it('keeps credential-free build and preview workflows read-only', async () => {
    for (const filename of ['compiled-products.yml', 'storybook-preview-build.yml'])
      for (const job of Object.values((await readWorkflow(filename)).jobs)) {
        expect(job.env?.BUCK2_PUBLIC_CACHE_READ_ONLY).toBe('1')
        expect(JSON.stringify(job)).not.toContain('secrets.BUCK2_PUBLIC_CACHE_WRITE_AUTH')
      }
  })
})
