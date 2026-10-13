import { describe, expect, it } from 'bun:test'

import { withBuck2CacheEvidence } from './buck2-cache-evidence.ts'

describe('Buck2 cache evidence workflow decorator', () => {
  it('starts before execution and uploads the summary and gzip together even after failure', () => {
    const jobs = withBuck2CacheEvidence({
      quality: {
        'runs-on': 'ubuntu-latest',
        env: { CI_SOURCE_ROOT: '/redirected/root' },
        steps: [{ uses: 'actions/checkout@v4' }, { name: 'Build', run: 'buck2 build //:quick' }],
      },
    })
    const job = jobs.quality!
    expect(job.env?.CI_SOURCE_ROOT).toBe('/redirected/root')
    expect(job.env?.CI_BUCK2_CACHE_ACTIONS_PATH).toBe(
      '${{ github.workspace }}/tmp/buck2-cache-actions.jsonl.gz',
    )
    const start = job.steps[1]!
    expect(start.name).toBe('Start Buck2 cache evidence window')
    expect('run' in start && start.run).toContain('CI_SOURCE_ROOT:-')
    expect('run' in start && start.run).toContain('git -C "$source_root" rev-parse --show-toplevel')
    expect('run' in start && start.run).toContain('[ "$tracked_root" = "$source_root" ]')
    expect('run' in start && start.run).toContain('[ ! -e "$source_root/buck-out" ]')
    expect('run' in start && start.run).toContain('[ ! -L "$source_root/buck-out" ]')
    expect('run' in start && start.run).toContain('fresh_root=0')
    expect('run' in start && start.run).toContain('CI_BUCK2_CACHE_EVIDENCE_STARTED_AT')
    expect(job.steps[2]?.name).toBe('Build')
    const collect = job.steps[3]!
    expect(collect.if).toBe('${{ always() }}')
    expect(collect['continue-on-error']).toBe(true)
    const upload = job.steps[4]!
    expect(upload.if).toBe('${{ always() }}')
    expect('with' in upload && upload.with?.path).toBe(
      '${{ env.CI_BUCK2_CACHE_EVIDENCE_PATH }}\n${{ env.CI_BUCK2_CACHE_ACTIONS_PATH }}',
    )
    expect('with' in upload && upload.with?.['retention-days']).toBe(14)
  })

  it('keeps jobs without checkout untouched', () => {
    const job = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'echo metadata' }] }
    expect(withBuck2CacheEvidence({ metadata: job }).metadata).toBe(job)
  })

  it('gives matrix artifacts separate names and preserves disabled-by-design posture', () => {
    const jobs = withBuck2CacheEvidence({
      'build-products': {
        'runs-on': 'ubuntu-latest',
        strategy: { matrix: { system: ['x86_64-linux', 'aarch64-linux'] } },
        steps: [{ uses: 'actions/checkout@v4' }],
      },
    })
    const job = jobs['build-products']!
    expect(job.env?.CI_BUCK2_CACHE_EVIDENCE_DISABLED).toBe('1')
    const upload = job.steps.at(-1)!
    expect('with' in upload && upload.with?.name).toBe(
      'buck2-cache-evidence-build-products-${{ strategy.job-index }}-${{ github.run_attempt }}',
    )
    expect('with' in upload && upload.with?.path).toContain('CI_BUCK2_CACHE_ACTIONS_PATH')
  })

  it('excludes Cargo and ref-policy jobs that do not execute native Buck actions', () => {
    for (const jobId of ['cargo', 'default-ref-policy']) {
      const jobs = withBuck2CacheEvidence({
        [jobId]: { 'runs-on': 'ubuntu-latest', steps: [{ uses: 'actions/checkout@v4' }] },
      })
      expect(jobs[jobId]!.env?.CI_BUCK2_CACHE_EVIDENCE_DISABLED).toBe('1')
    }
  })
})
