import { expect, test } from 'bun:test'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const runner = fileURLToPath(new URL('./bun-test-runner.ts', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/bun-timeout.fixture.ts', import.meta.url))

test('JUnit distinguishes timed-out tests from assertions without changing the failing exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bun-timeout-fixture-'))
  try {
    await copyFile(fixture, join(root, 'fixture.test.ts'))
    const child = Bun.spawn([process.execPath, runner, './fixture.test.ts'], {
      cwd: root,
      env: { ...process.env, BUN_TEST_TIMEOUT_CAP: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const output = `${stdout}${stderr}`
    expect(status).toBe(1)
    const timeouts = output
      .split('\n')
      .filter((line) => line.startsWith('test-timeout-under-load '))
    expect(timeouts).toHaveLength(3)
    expect(timeouts[0]).toContain('file="fixture.test.ts"')
    expect(timeouts[0]).toContain('test="classification fixture > deliberate timeout"')
    expect(timeouts[0]).toContain('base=20 factor=1 effective=20 deadlineMs=20')
    for (const line of timeouts.slice(1)) expect(line).toContain('base=10 factor=1 effective=10')
    for (const line of timeouts) {
      const elapsed = Number(/elapsedMs=([\d.]+)/u.exec(line)?.[1])
      expect(elapsed).toBeGreaterThanOrEqual(10)
      expect(line).toMatch(/load1=[\d.]+ cpus=\d+ memPsiFullAvg10=(?:[\d.]+|unavailable)/u)
    }
    expect(output).toContain(
      'test-failure-summary timeoutFailures=3 assertionFailures=1 otherFailures=0',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
