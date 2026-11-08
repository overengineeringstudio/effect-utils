import { describe, expect, it } from 'bun:test'

import { validateWorkflowCachePolicy } from '../../packages/@overeng/genie/src/runtime/github-workflow/cache-policy.ts'
import { standaloneCachePostureConfig } from '../../scripts/buck2-cache-posture.ts'
import {
  buck2CachePostureEnv,
  withBuck2CachePostures,
  withMacosMeasurementDispatch,
} from './buck2-cache-posture.ts'

const mainOnlyJob = {
  if: "${{ github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}",
  'runs-on': 'namespace-profile-linux-x86-64',
  env: { CI: 'true' },
  steps: [{ run: 'buck2 build //...' }],
}
const prJob = {
  if: "${{ github.event_name == 'pull_request' }}",
  'runs-on': 'ubuntu-latest',
  steps: [{ run: 'buck2 test //...' }],
}

describe('declared Buck2 job cache posture', () => {
  it('declares CI posture for every cache policy, including disabled readers and none', () => {
    for (const posture of ['writer', 'trusted-writer', 'reader', 'none'] as const)
      expect(buck2CachePostureEnv(posture).BUCK2_CI_POSTURE).toBe('1')
    expect(
      buck2CachePostureEnv({ posture: 'reader', disabledWhen: 'inputs.disabled' }).BUCK2_CI_POSTURE,
    ).toBe('1')
  })

  it('preserves protected writer guards verbatim for the cache-policy validator', () => {
    const publisher = {
      ...mainOnlyJob,
      if: "${{ github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && !(github.event_name == 'workflow_dispatch' && inputs['measure-macos'] == true) }}",
      steps: [
        {
          run: 'cachix push fixture',
          env: { CACHIX_AUTH_TOKEN: '${{ secrets.CACHIX_AUTH_TOKEN }}' },
        },
      ],
    }
    const jobs = withMacosMeasurementDispatch({
      jobs: { 'publish-products': publisher, 'trusted-buck2-remote-cache-proof': publisher },
      postures: { 'publish-products': 'none', 'trusted-buck2-remote-cache-proof': 'writer' },
    })
    for (const job of Object.values(jobs)) {
      expect(job.if).toBe(publisher.if)
      expect(
        new Function('github', 'inputs', `return (${job.if!.slice(3, -2)})`)(
          { event_name: 'workflow_dispatch', ref: 'refs/heads/main' },
          { 'measure-macos': true },
        ),
      ).toBe(false)
    }
    expect(() =>
      validateWorkflowCachePolicy({
        workflow: {
          name: 'fixture',
          on: { push: { branches: ['main'] }, workflow_dispatch: {} },
          jobs,
        },
      }),
    ).not.toThrow()
  })

  it('preserves push-only promotion and unrelated job cleanup conditions', () => {
    const promotion = { ...prJob, if: "github.event_name == 'push'" }
    const cleanup = { name: 'Collect Buck2 cache evidence', if: '${{ always() }}', run: ':' }
    const jobs = withMacosMeasurementDispatch({
      jobs: { 'promote-published': promotion, quality: { ...prJob, steps: [cleanup] } },
      postures: { 'promote-published': 'none', quality: 'trusted-writer' },
    })
    expect(jobs['promote-published']!.if).toBe(promotion.if)
    expect(jobs.quality!.steps).toEqual([cleanup])
  })

  it('measures dispatches without writes, local saves, or published join evidence', () => {
    const names = [
      'Unit tests',
      'Save signed store paths',
      'Warm local Nix substituter after bootstrap',
      'Upload Buck2 cache evidence',
    ]
    const jobs = withMacosMeasurementDispatch({
      jobs: {
        'test-macos': { ...prJob, steps: names.map((name) => ({ name, run: ':' })) },
        'pipeline-traces': prJob,
      },
      postures: { 'test-macos': 'trusted-writer', 'pipeline-traces': 'none' },
    })
    for (const ref of ['refs/heads/main', 'refs/heads/feature']) {
      const evaluate = (value: string) =>
        new Function('github', 'inputs', 'success', 'always', `return (${value.slice(3, -2)})`)(
          { event_name: 'workflow_dispatch', ref },
          { 'measure-macos': true },
          () => true,
          () => true,
        )
      const macos = jobs['test-macos']!
      expect(evaluate(macos.if!)).toBe(true)
      expect(evaluate(jobs['pipeline-traces']!.if!)).toBe(false)
      expect(evaluate(macos.env!.BUCK2_PUBLIC_CACHE_READ_ONLY!)).toBe('1')
      expect(macos.steps.slice(1, 4).every((step) => evaluate(step.if!) === false)).toBe(true)
    }
  })

  it('uses the same measurement guard for OIDC authentication and artifact/trace publication', () => {
    const protectedSteps = [
      { uses: 'tailscale/github-action@fixture', if: '${{ always() }}' },
      { uses: 'actions/upload-artifact@fixture', if: '${{ always() }}' },
      { name: 'Export completed job trace', if: '${{ always() }}', run: ':' },
    ]
    const jobs = withMacosMeasurementDispatch({
      jobs: { 'test-macos': { ...prJob, steps: protectedSteps } },
      postures: { 'test-macos': 'trusted-writer' },
    })
    for (const measurement of [true, false]) {
      for (const step of jobs['test-macos']!.steps.slice(0, protectedSteps.length)) {
        expect(
          new Function('github', 'inputs', 'always', `return (${step.if!.slice(3, -2)})`)(
            { event_name: 'workflow_dispatch' },
            { 'measure-macos': measurement },
            () => true,
          ),
        ).toBe(!measurement)
      }
    }
  })

  it('allows the declared main-only writer to upload while PR readers and inert jobs cannot', () => {
    const jobs = withBuck2CachePostures({
      jobs: { publisher: mainOnlyJob, pullRequest: prJob, inert: prJob },
      postures: { publisher: 'writer', pullRequest: 'reader', inert: 'none' },
    })
    const credential = 'smoke-writer-credential'
    const configs = Object.fromEntries(
      Object.entries(jobs).map(([id, job]) => [
        id,
        standaloneCachePostureConfig({
          current: '',
          env: { ...job.env, BUCK2_CACHE_WRITE_BASIC_AUTH: credential },
        }),
      ]),
    )
    expect(configs.publisher).toContain('allow_cache_uploads = true')
    expect(configs.publisher).toContain('authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH')
    expect(configs.publisher).not.toContain(credential)
    expect(configs.pullRequest).toContain('remote_cache_enabled = true')
    expect(configs.pullRequest).toContain('allow_cache_uploads = false')
    expect(configs.pullRequest).not.toContain('http_headers')
    expect(configs.inert).toContain('remote_cache_enabled = false')
    expect(configs.inert).toContain('allow_cache_uploads = false')
    expect(configs.inert).not.toContain('http_headers')
  })

  it('rejects conflicting explicit cache settings instead of silently overriding them', () => {
    const conflictingWriterEnvs: Array<Record<string, string>> = [
      { BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
      { BUCK2_CI_POSTURE: '0' },
      { BUCK2_NO_REMOTE_CACHE: '1' },
    ]
    for (const env of conflictingWriterEnvs) {
      expect(() =>
        withBuck2CachePostures({
          jobs: { publisher: { ...mainOnlyJob, env } },
          postures: { publisher: 'writer' },
        }),
      ).toThrow()
    }
    expect(() =>
      withBuck2CachePostures({
        jobs: { pullRequest: { ...prJob, env: { BUCK2_PUBLIC_CACHE_READ_ONLY: '0' } } },
        postures: { pullRequest: 'reader' },
      }),
    ).toThrow()
    expect(() =>
      withBuck2CachePostures({
        jobs: { inert: { ...prJob, env: { BUCK2_NO_REMOTE_CACHE: '0' } } },
        postures: { inert: 'none' },
      }),
    ).toThrow()
  })

  it('rejects jobs without a declaration', () => {
    expect(() =>
      withBuck2CachePostures({
        jobs: { publisher: mainOnlyJob, pullRequest: prJob },
        postures: { publisher: 'writer' },
      }),
    ).toThrow()
  })

  it('rejects declarations for unknown jobs', () => {
    expect(() =>
      withBuck2CachePostures({
        jobs: { pullRequest: prJob },
        postures: { pullRequest: 'reader', nonexistent: 'writer' },
      }),
    ).toThrow()
  })
})
