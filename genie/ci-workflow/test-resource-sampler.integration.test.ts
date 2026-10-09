import { describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sampler = new URL('../ci-scripts/test-resource-sampler.sh', import.meta.url).pathname

type ResourceReport = { rssSemantics: string; cpuSemantics: string }
type WorkflowStep = {
  name?: string
  run?: string
  if?: string
  'continue-on-error'?: boolean
  with?: Record<string, string>
}
type GeneratedWorkflow = { jobs: Record<string, { steps: readonly WorkflowStep[] }> }

const runFixture = async ({
  missing = false,
  forceKill = false,
}: { missing?: boolean; forceKill?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'test-resource-sampler-'))
  const output = join(root, 'resources.json')
  const scripts = {
    uname: 'echo Darwin',
    sysctl: 'echo 30000000000',
    ps: missing === true ? 'exit 1' : "printf '1024 100.5\n2048 25.0\n'",
    vm_stat:
      "printf 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor: 3.\nPageouts: 7.\n'",
    sleep: 'echo "sample-complete:$BASHPID"; exec /bin/sleep "$@"',
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
    let sleeperPid: number | undefined
    try {
      const reader = proc.stdout.getReader()
      const signal = await reader.read()
      reader.releaseLock()
      const message = new TextDecoder().decode(signal.value)
      expect(message).toContain('sample-complete')
      const pid = message.match(/sample-complete:(\d+)/)?.[1]
      if (pid === undefined) throw new Error('sampler sleep ownership is missing')
      sleeperPid = Number(pid)
      proc.kill(forceKill === true ? 'SIGKILL' : 'SIGTERM')
      const status = await proc.exited
      return {
        status,
        report: (await Bun.file(output).exists())
          ? ((await Bun.file(output).json()) as ResourceReport)
          : undefined,
      }
    } finally {
      if (sleeperPid !== undefined) {
        try {
          process.kill(sleeperPid, 'SIGKILL')
        } catch {
          // TERM normally reaps the sleep first.
        }
      }
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
    if (report === undefined) throw new Error('native resource report is missing')
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

  it('retains completed native samples when forcibly killed without an exit flush', async () => {
    const { status, report } = await runFixture({ forceKill: true })
    expect(status).not.toBe(0)
    expect(report).toMatchObject({ sampleCount: 1, peakSummedProcessRssBytes: 3_145_728 })
  })

  it('does not fabricate peaks when native sampling fails', async () => {
    const { status, report } = await runFixture({ missing: true })
    expect(status).toBe(1)
    expect(report).toBeUndefined()
  })

  it('keeps both generated test lanes diagnostic-only and preserves test exit status', async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(new URL('../../.github/workflows/ci.yml', import.meta.url)).text(),
    ) as GeneratedWorkflow
    for (const name of ['test', 'test-macos']) {
      const steps = workflow.jobs[name]?.steps
      if (steps === undefined) throw new Error(`required test job is missing: ${name}`)
      const unit = steps.find((step) => step.name === 'Unit tests')
      if (unit === undefined) throw new Error(`unit-test step is missing: ${name}`)
      expect(unit.run).toContain('test-resource-sampler.sh')
      expect(unit.run).toContain('status=$?; trap - EXIT;')
      expect(unit.run).toContain('kill -TERM -- "-$resource_sampler"')
      expect(unit.run).toContain('kill -KILL -- "-$resource_sampler"')
      expect(unit.run).not.toContain('wait "$resource_sampler"')
      expect(unit.run).toContain('exit "$status"')
      expect(unit.run).toContain('tasks run test:run')
      const artifact = steps.find((step) => step.name === 'Upload test resource samples')
      if (artifact === undefined) throw new Error(`resource artifact is missing: ${name}`)
      expect(artifact.if).toBe('${{ always() }}')
      expect(artifact['continue-on-error']).toBe(true)
      expect(artifact.with?.['if-no-files-found']).toBe('ignore')
    }
  })

  it('finishes the generated test step while a native sampler child is stalled', async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(new URL('../../.github/workflows/ci.yml', import.meta.url)).text(),
    ) as GeneratedWorkflow
    const unit = workflow.jobs.test?.steps.find((step) => step.name === 'Unit tests')?.run
    if (unit === undefined) throw new Error('unit-test command is missing')
    const start = unit.indexOf('set -m\n')
    if (start === -1) throw new Error('private sampler process group is missing')
    const lifecycle = unit.slice(start).split('\n').slice(0, 5).join('\n')
    const root = await mkdtemp(join(tmpdir(), 'test-resource-stalled-'))
    try {
      const mockPs = join(root, 'ps')
      await writeFile(
        mockPs,
        '#!/usr/bin/env bash\necho native-sampler-stalled >&2\nexec /bin/sleep 3600\n',
      )
      await chmod(mockPs, 0o755)
      const proc = Bun.spawn(['bash', '-c', `${lifecycle}\nread -r release\nexit 19`], {
        cwd: new URL('../../', import.meta.url).pathname,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      try {
        const reader = proc.stderr.getReader()
        const signal = await reader.read()
        reader.releaseLock()
        expect(new TextDecoder().decode(signal.value)).toContain('native-sampler-stalled')
        proc.stdin.end('release\n')
        expect(await proc.exited).toBe(19)
        // EOF requires the stalled native child to release its inherited pipe.
        await proc.stderr.pipeTo(new WritableStream())
      } finally {
        if (proc.exitCode === null) proc.stdin.end('release\n')
        await proc.exited
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
