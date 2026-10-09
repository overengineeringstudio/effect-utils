import { describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sampler = new URL('../ci-scripts/test-resource-sampler.sh', import.meta.url).pathname

const runFixture = async ({ missing = false }: { missing?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'test-resource-sampler-'))
  const output = join(root, 'resources.json')
  const scripts = {
    uname: 'echo Darwin',
    sysctl: 'echo 30000000000',
    ps: missing === true ? 'exit 1' : "printf '1024 100.5\n2048 25.0\n'",
    vm_stat:
      "printf 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor: 3.\nPageouts: 7.\n'",
    sleep: 'echo sample-complete; exec /bin/sleep "$@"',
  }
  try {
    for (const [name, body] of Object.entries(scripts)) {
      const path = join(root, name)
      await writeFile(path, `#!/usr/bin/env bash\n${body}\n`)
      await chmod(path, 0o755)
    }
    const proc = Bun.spawn(['bash', sampler, output], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const reader = proc.stdout.getReader()
      const signal = await reader.read()
      reader.releaseLock()
      expect(new TextDecoder().decode(signal.value)).toContain('sample-complete')
      proc.kill('SIGTERM')
      const status = await proc.exited
      return {
        status,
        report: (await Bun.file(output).exists()) ? await Bun.file(output).json() : undefined,
      }
    } finally {
      proc.kill('SIGTERM')
      await proc.exited
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('non-gating resource sampling', () => {
  it('retains native Darwin metrics and truthful CPU/RSS semantics on stop', async () => {
    const { status, report } = await runFixture()
    expect(status).toBe(0)
    expect(report).toMatchObject({
      schemaVersion: 1,
      platform: 'Darwin',
      scope: 'host',
      sampleIntervalSeconds: 5,
      sampleCount: 1,
      failedSampleCount: 0,
      totalMemoryBytes: 30_000_000_000,
      peakSummedProcessRssBytes: 3_145_728,
      peakSummedProcessLifetimeCpuPercent: 125.5,
      peakCompressorBytes: 49_152,
      pageoutsDuringSampling: 0,
    })
    expect(report.rssSemantics).toContain('shared pages')
    expect(report.cpuSemantics).toContain('lifetime-average')
  })

  it('does not fabricate peaks when native sampling fails', async () => {
    const { status, report } = await runFixture({ missing: true })
    expect(status).toBe(1)
    expect(report).toBeUndefined()
  })

  it('keeps both generated test lanes diagnostic-only and preserves test exit status', async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(new URL('../../.github/workflows/ci.yml', import.meta.url)).text(),
    )
    for (const name of ['test', 'test-macos']) {
      const steps = workflow.jobs[name].steps
      const unit = steps.find((step: { name?: string }) => step.name === 'Unit tests')
      expect(unit.run).toContain('test-resource-sampler.sh')
      expect(unit.run).toContain('status=$?; trap - EXIT;')
      expect(unit.run).toContain('wait "$resource_sampler" || :; exit "$status"')
      expect(unit.run).toContain('tasks run test:run')
      const artifact = steps.find(
        (step: { name?: string }) => step.name === 'Upload test resource samples',
      )
      expect(artifact.if).toBe('${{ always() }}')
      expect(artifact['continue-on-error']).toBe(true)
      expect(artifact.with['if-no-files-found']).toBe('ignore')
    }
  })
})
