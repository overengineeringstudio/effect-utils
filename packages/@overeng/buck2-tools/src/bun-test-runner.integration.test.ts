import { expect, test } from 'bun:test'
import { appendFile, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const runner = fileURLToPath(new URL('./bun-test-runner.ts', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/bun-timeout.fixture.ts', import.meta.url))

test('JUnit distinguishes timed-out tests from assertions without changing the failing exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bun-timeout-fixture-'))
  try {
    await copyFile(fixture, join(root, 'fixture.test.ts'))
    await writeFile(
      join(root, 'shared-helper.ts'),
      "import { test } from 'bun:test'\nexport const registerTimeout = () => test('imported helper timeout', () => Promise.withResolvers<void>().promise, 15)\n",
    )
    await appendFile(
      join(root, 'fixture.test.ts'),
      "\nimport { registerTimeout } from './shared-helper.ts'\nregisterTimeout()\n",
    )
    const child = Bun.spawn([process.execPath, runner, 'test', './fixture.test.ts'], {
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
    const cases = [
      { title: 'classification fixture > deliberate timeout', base: 20 },
      { title: 'classification fixture > parameterized timeout alpha', base: 10 },
      { title: 'classification fixture > parameterized timeout beta', base: 10 },
      { title: 'classification fixture > object case first', base: 13 },
      { title: 'classification fixture > object case second', base: 13 },
      { title: 'classification fixture > scope short > scoped timeout', base: 7 },
      { title: 'classification fixture > scope long > scoped timeout', base: 11 },
      { title: 'classification fixture > filtered timeout excluded', base: 23 },
      { title: 'classification fixture > filtered timeout selected', base: 29 },
      { title: 'imported helper timeout', base: 15 },
    ]
    expect(timeouts).toHaveLength(cases.length)
    for (const { title, base } of cases) {
      expect(output).toContain(`test=${JSON.stringify(title)} `)
      const line = timeouts.find((entry) => entry.includes(`test=${JSON.stringify(title)} `))
      expect(line).toContain(`base=${base} factor=1 effective=${base} deadlineMs=${base}`)
      expect(line).toContain('file="fixture.test.ts"')
    }
    for (const line of timeouts) {
      const elapsed = Number(/elapsedMs=([\d.]+)/u.exec(line)?.[1])
      expect(elapsed).toBeGreaterThan(0)
      expect(line).toMatch(/load1=[\d.]+ cpus=\d+ memPsiFullAvg10=(?:[\d.]+|unavailable)/u)
    }
    expect(output).toContain(
      'test-failure-summary timeoutFailures=10 assertionFailures=1 otherFailures=0',
    )
    const filtered = Bun.spawn(
      [
        process.execPath,
        runner,
        'test',
        './fixture.test.ts',
        '--test-name-pattern=filtered timeout selected',
      ],
      {
        cwd: root,
        env: { ...process.env, BUN_TEST_TIMEOUT_CAP: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [filteredStatus, filteredOut, filteredError] = await Promise.all([
      filtered.exited,
      new Response(filtered.stdout).text(),
      new Response(filtered.stderr).text(),
    ])
    expect(filteredStatus).toBe(1)
    expect(`${filteredOut}${filteredError}`).toContain(
      'base=29 factor=1 effective=29 deadlineMs=29',
    )
    expect(`${filteredOut}${filteredError}`).toContain(
      'test-failure-summary timeoutFailures=1 assertionFailures=0 otherFailures=0',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
