import { describe, expect, it } from 'bun:test'

import { withBuck2CacheEvidence } from './buck2-cache-evidence.ts'
import { coreCachePostures, coreProofDisabledJobIds } from './buck2-cache-proof-policy.ts'

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
    expect(job.env?.CI_BUCK2_CACHE_EVIDENCE_JOB_NAME).toBe('quality')
    expect(job.name).toBeUndefined()
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
      [
        '${{ env.CI_BUCK2_CACHE_EVIDENCE_PATH }}',
        '${{ env.CI_BUCK2_CACHE_ACTIONS_PATH }}',
        '${{ env.CI_BUCK2_CACHE_WARM99_PATH }}',
        '${{ env.CI_BUCK2_CACHE_PROOF_MANIFEST_PATH }}',
        '${{ env.CI_BUCK2_CACHE_EVIDENCE_PATH }}.shard-index.json',
        '${{ env.CI_BUCK2_CACHE_EVIDENCE_PATH }}.shards/*.json',
      ].join('\n'),
    )
    expect('with' in upload && upload.with?.path).not.toContain('native-build-id-paths')
    expect('with' in upload && upload.with?.['retention-days']).toBe(90)
  })

  it('keeps jobs without checkout untouched', () => {
    const job = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'echo metadata' }] }
    expect(withBuck2CacheEvidence({ metadata: job }).metadata).toBe(job)
  })

  it('gives native matrix artifacts separate names', () => {
    const jobs = withBuck2CacheEvidence({
      test: {
        'runs-on': 'ubuntu-latest',
        strategy: { matrix: { system: ['x86_64-linux', 'aarch64-linux'] } },
        steps: [{ uses: 'actions/checkout@v4' }],
      },
    })
    const job = jobs.test!
    expect(job.env?.CI_BUCK2_CACHE_EVIDENCE_DISABLED).toBe('0')
    expect(job.name).toBeUndefined()
    expect(job.env?.CI_BUCK2_CACHE_EVIDENCE_JOB_NAME).toBe('test (${{ matrix.system }})')
    const upload = job.steps.at(-1)!
    expect('with' in upload && upload.with?.name).toBe(
      'buck2-cache-evidence-test-${{ strategy.job-index }}-${{ github.run_attempt }}',
    )
    expect('with' in upload && upload.with?.path).toContain('CI_BUCK2_CACHE_ACTIONS_PATH')
  })

  it('preserves explicit required-check names and ordered default matrix names', () => {
    const jobs = withBuck2CacheEvidence({
      test: {
        name: 'test (${{ matrix.runner }})',
        'runs-on': 'ubuntu-latest',
        strategy: { matrix: { runner: ['linux', 'macos'] } },
        steps: [{ uses: 'actions/checkout@v4' }],
      },
      multi: {
        'runs-on': 'ubuntu-latest',
        strategy: { matrix: { runner: ['linux'], version: ['22'] } },
        steps: [{ uses: 'actions/checkout@v4' }],
      },
      dynamic: {
        'runs-on': 'ubuntu-latest',
        strategy: { matrix: '${{ fromJSON(needs.plan.outputs.matrix) }}' },
        steps: [{ uses: 'actions/checkout@v4' }],
      },
    })
    expect(jobs.test!.name).toBe('test (${{ matrix.runner }})')
    expect(jobs.test!.env?.CI_BUCK2_CACHE_EVIDENCE_JOB_NAME).toBe(jobs.test!.name)
    expect(jobs.multi!.name).toBeUndefined()
    expect(jobs.multi!.env?.CI_BUCK2_CACHE_EVIDENCE_JOB_NAME).toBe(
      'multi (${{ matrix.runner }}, ${{ matrix.version }})',
    )
    expect(jobs.dynamic!.env?.CI_BUCK2_CACHE_EVIDENCE_JOB_NAME).toBeUndefined()
  })

  it('does not start or upload native proof for deliberately non-native jobs', () => {
    for (const jobId of Object.keys(coreProofDisabledJobIds)) {
      const steps = [{ uses: 'actions/checkout@v4' }, { run: 'echo non-native workload' }]
      const jobs = withBuck2CacheEvidence({
        [jobId]: { 'runs-on': 'ubuntu-latest', steps },
      })
      const job = jobs[jobId]!
      expect(job.env?.CI_BUCK2_CACHE_EVIDENCE_DISABLED).toBe('1')
      expect(job.env?.CI_BUCK2_CACHE_EVIDENCE_START).toBeUndefined()
      expect(job.env?.CI_BUCK2_CACHE_PROOF_MANIFEST_PATH).toBeUndefined()
      expect(job.steps).toBe(steps)
    }
    expect(coreCachePostures['source-shape']).toBe('none')
    expect(coreProofDisabledJobIds['source-shape']).toBe(true)
    expect(coreProofDisabledJobIds['main-source-shape']).toBe(true)
    for (const jobId of ['quality', 'test', 'weaver', 'trusted-buck2-remote-cache-proof'])
      expect(coreProofDisabledJobIds[jobId]).toBeUndefined()
  })
})
