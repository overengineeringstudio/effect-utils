import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These real child processes expose readiness through fixture files. A fake
// clock cannot advance the native process or gate-slot's admission-time timer.
const waitFor = async (description: string, condition: () => boolean) => {
  const deadline = Date.now() + 30000
  while (condition() === false) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await Bun.sleep(25)
  }
}

const teardownFixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buck2-gate-teardown-')))
  const packaged = process.env['BUCK2_BIN'] ?? Bun.which('buck2')
  if (packaged === null || packaged === undefined) throw new Error('pinned buck2 wrapper required')
  // Use the packaged interpreter, not a possible process-wrapping PATH shim.
  const bash = /^#!(\/\S+)\n/u.exec(readFileSync(packaged, 'utf8'))?.[1]
  if (bash === undefined) throw new Error('expected pinned Buck wrapper interpreter')
  const native = join(root, 'native')
  const launcher = join(root, 'launcher')
  const wrapper = join(root, 'buck2')
  const ready = join(root, 'ready.json')
  const killed = join(root, 'kill-calls.jsonl')
  writeFileSync(join(root, '.buckroot'), '')
  writeFileSync(join(root, '.buckconfig'), '[cells]\nroot = .\n')
  writeFileSync(
    native,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args.at(-1) === 'status') {
  // No daemon exists during admission; only the invocation creates this
  // fixture-owned daemon identity. Never consult a host Buck daemon.
  if (existsSync(${JSON.stringify(ready)})) {
    console.log(JSON.stringify({project_root: ${JSON.stringify(root)}, isolation_dir: 'owned', active_commands: [], process_info: {pid: process.ppid}}))
  }
} else if (args.at(-1) === 'kill') {
  appendFileSync(${JSON.stringify(killed)}, JSON.stringify(args) + '\\n')
} else {
  if (process.env.BUCK2_GATE_WRAPPER_ACTIVE !== '1') process.exit(71)
  process.on('SIGTERM', () => process.exit(0))
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    input += chunk
    if (!input.includes('fixture stdin\\n')) return
    console.log('fixture native stdout')
    console.error('fixture native stderr')
    writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid: process.pid, cgroup: process.platform === 'linux' ? readFileSync('/proc/self/cgroup', 'utf8') : undefined}))
  })
  await Promise.withResolvers().promise
}
`,
    { mode: 0o700 },
  )
  writeFileSync(
    launcher,
    `#!${bash}\nexec '${process.execPath}' '${join(import.meta.dir, 'buck2-entrypoint.ts')}' "$@"\n`,
    { mode: 0o700 },
  )
  writeFileSync(
    wrapper,
    readFileSync(join(import.meta.dir, 'buck2-entrypoint.sh'), 'utf8')
      .replaceAll('@shell@', bash)
      .replaceAll('@native@', native)
      .replaceAll('@launcher@', launcher)
      .replaceAll('@sha256@', Bun.which('sha256sum') ?? 'false'),
    { mode: 0o700 },
  )
  const argv = [wrapper, '--isolation-dir', 'owned', 'build', '//:fixture']
  const env = {
    ...process.env,
    HOME: root,
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    BUCK2_GATE_WRAPPER_ACTIVE: undefined,
    GATE_SLOT_CLASS: 'heavy',
  }
  return {
    root,
    ready,
    argv,
    env,
    killCalls: () =>
      readFileSync(killed, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  }
}

const assertLifecycleOutput = (stdout: string, stderr: string) => {
  expect(stdout).toBe('fixture native stdout\n')
  expect(stderr).toContain('fixture native stderr\n')
}

// Always reap the wrapper and any still-live native before removing its files,
// including when an assertion or readiness deadline fails.
const dispose = async (
  fixture: { readonly root: string; readonly ready: string },
  child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>,
) => {
  child.stdin.end()
  if (child.exitCode === null) child.kill('SIGTERM')
  // Real OS children cannot be reaped with fake timers. This is only a
  // failure-path bound, not a readiness delay or part of the timer assertion.
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The fixture's detached process group has already drained.
    }
    if (existsSync(fixture.ready) === true) {
      const { pid } = JSON.parse(readFileSync(fixture.ready, 'utf8'))
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The fixture native has already exited.
      }
    }
  }, 5000)
  try {
    await child.exited
  } finally {
    clearTimeout(timer)
    rmSync(fixture.root, { recursive: true, force: true })
  }
}

describe('gate wrapper native-only death and real gate-slot expiry', () => {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    it(`cleans exactly once when only the native client receives ${signal}`, async () => {
      const fixture = teardownFixture()
      const child = Bun.spawn(fixture.argv, {
        cwd: fixture.root,
        env: fixture.env,
        detached: true,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      try {
        child.stdin.write('fixture stdin\n')
        await waitFor('native client readiness', () => existsSync(fixture.ready))
        const { pid } = JSON.parse(readFileSync(fixture.ready, 'utf8'))
        expect(pid).not.toBe(child.pid)
        // Deliberately target neither the wrapper nor its process group.
        process.kill(pid, signal)
        expect(await child.exited, await stderr).toBe(signal === 'SIGTERM' ? 0 : 137)
        assertLifecycleOutput(await stdout, await stderr)
        expect(fixture.killCalls()).toEqual([['--isolation-dir', 'owned', 'kill']])
      } finally {
        await dispose(fixture, child)
      }
    }, 60000)
  }

  it('preserves real gate-slot max-hold expiry and runs the wrapper cleanup exactly once', async () => {
    const gate = Bun.which('gate-slot')
    if (gate === null) throw new Error('actual gate-slot required for the max-hold regression')
    const fixture = teardownFixture()
    const child = Bun.spawn(
      [gate, '--class', 'heavy', '--max-wait', '10', '--max-hold', '8', '--', ...fixture.argv],
      {
        cwd: fixture.root,
        env: {
          ...fixture.env,
          // Private admission state avoids competing with the real parent's
          // build slot. The source-supported fixture switch retains its physical
          // cgroup instead of asking systemd to move work outside that scope.
          GATE_SLOT_TEST_FIXTURE: '1',
          GATE_SLOT_TEST_NO_SYSTEMD: '1',
          GATE_SLOTS_DIR: join(fixture.root, 'slots'),
          GATE_SLOTS_FENCE_DIR: join(fixture.root, 'fences'),
          GATE_SLOTS_HEAVY: '1',
          GATE_SLOTS_HEAVY_PRIORITY: '0',
          GATE_SLOTS_POLL: '0.1',
          // A private root cannot validate a real parent's holder record.
          // gate-slot sets fresh markers on admission, including CLASS, which
          // the actual Buck wrapper must receive (not an inherited bypass).
          GATE_SLOT_CLASS: undefined,
          GATE_SLOT_LANE: undefined,
          GATE_SLOT_ADMITTED: undefined,
          GATE_SLOT_ADMITTED_ID: undefined,
          GATE_SLOT_PRIORITY: '0',
        },
        detached: true,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    try {
      child.stdin.write('fixture stdin\n')
      await waitFor('gate-admitted native client', () => existsSync(fixture.ready))
      if (process.platform === 'linux') {
        const { cgroup } = JSON.parse(readFileSync(fixture.ready, 'utf8'))
        expect(cgroup).toBe(readFileSync('/proc/self/cgroup', 'utf8'))
      }
      expect(await child.exited, await stderr).toBe(124)
      const output = await stderr
      assertLifecycleOutput(await stdout, output)
      expect(output).toMatch(/admitted class=heavy .*max-hold=8s lane=build/u)
      expect(output).toContain('max hold 8s reached; exit=124 (max hold expired); SIGTERM to pgid')
      expect(output).toContain('command-exited exit=143')
      expect(fixture.killCalls()).toEqual([['--isolation-dir', 'owned', 'kill']])
    } finally {
      await dispose(fixture, child)
    }
  }, 60000)
})
