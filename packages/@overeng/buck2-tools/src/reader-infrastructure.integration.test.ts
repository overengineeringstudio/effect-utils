import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { classifyEditorViewProcessCandidates } from './editor-view-readers.ts'
import { isLinuxReaderInfrastructureIdentity } from './reader-infrastructure.ts'

const nativeFs = { ...process.getBuiltinModule('fs') }
const scheduling: { beforeReadlink?: (path: unknown) => void } = {}
// Use the suite's stable forwarding-export convention: Bun caches named native
// imports, so mutating fs.readlinkSync/syncBuiltinESMExports does not intercept
// the scanner. This wrapper changes scheduling only; all I/O is genuine.
vi.mock('node:fs', () => ({
  ...nativeFs,
  readlinkSync: new Proxy(nativeFs.readlinkSync, {
    apply(target, thisArg, args) {
      scheduling.beforeReadlink?.(args[0])
      return Reflect.apply(target, thisArg, args)
    },
  }),
}))

const requireHelper = (): string => {
  const helper = process.env.EDITOR_VIEW_READER_INFRASTRUCTURE_TEST_CHILD_BIN
  if (helper === undefined || helper === '')
    throw new Error(
      'declared test tool is unavailable: EDITOR_VIEW_READER_INFRASTRUCTURE_TEST_CHILD_BIN',
    )
  return helper
}

/** Exercise the production census, not an injected permission-error provider. */
const observeNondumpable = async ({
  comm,
  cmdline,
  exempt,
}: {
  readonly comm: string
  readonly cmdline: readonly [string, ...string[]]
  readonly exempt: boolean
}): Promise<void> => {
  const helper = requireHelper()
  const root = mkdtempSync(join(tmpdir(), 'editor-reader-infrastructure-'))
  const child = spawn(helper, cmdline.slice(1), {
    argv0: cmdline[0],
    env: { ...process.env, EDITOR_VIEW_READER_TEST_COMM: comm },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''
      let diagnostics = ''
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        if (output === 'ready\n') resolve()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        diagnostics += chunk.toString()
      })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        reject(
          new Error(
            `nondumpable helper exited before observation: ${code}/${signal}: ${diagnostics}`,
          ),
        )
      })
    })
    expect(child.pid).toBeDefined()
    const base = `/proc/${child.pid}`
    const observedComm = readFileSync(join(base, 'comm'), 'utf8').trimEnd()
    const observedCmdline = readFileSync(join(base, 'cmdline'), 'utf8').split('\0')
    if (observedCmdline.at(-1) === '') observedCmdline.pop()
    expect(observedComm).toBe(comm)
    expect(observedCmdline).toEqual(cmdline)
    const status = readFileSync(join(base, 'status'), 'utf8')
    const uid = Number(/^Uid:\s+([0-9]+)/m.exec(status)?.[1])
    expect(uid).toBe(process.getuid?.())
    expect(
      isLinuxReaderInfrastructureIdentity({
        platform: process.platform,
        comm: observedComm,
        cmdline: observedCmdline,
        uid,
        currentUid: process.getuid?.(),
      }),
    ).toBe(exempt)
    // This MUST really fail in the kernel. A privileged test runner that can
    // inspect nondumpable processes is not evidence for this regression gate.
    expect(() => readlinkSync(join(base, 'cwd'))).toThrowError(
      expect.objectContaining({ code: 'EACCES' }),
    )
    expect(() => readFileSync(join(base, 'maps'))).toThrowError(
      expect.objectContaining({ code: 'EACCES' }),
    )

    const candidate = {
      key: 'unreferenced-generation',
      editorRoot: join(root, '.editor-view'),
      snapshotRoot: join(root, '.editor-view', '.store', 'default-test'),
      linkedInodes: [],
    }
    const evidence = classifyEditorViewProcessCandidates({ candidates: [candidate] }).get(
      candidate.key,
    )
    expect(evidence).toBeDefined()
    // Other real same-user processes can independently make a whole-host scan
    // unknown. Assert precisely whether THIS kernel-denied process blocks it;
    // do not mock away other processes or treat their unknown evidence as clear.
    const ownReasons = evidence?.reasons.filter((reason) => reason.includes(`${base}/`)) ?? []
    if (exempt === true) {
      expect(ownReasons).toEqual([])
    } else {
      expect(evidence?.state).toBe('unknown')
      expect(ownReasons.some((reason) => reason.includes('EACCES'))).toBe(true)
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform !== 'linux')(
  'real nondumpable Linux infrastructure readers',
  () => {
    it.each([
      { comm: 'sshd-session', cmdline: ['sshd-session: schickling@notty'] as const },
      { comm: 'sshd-session', cmdline: ['sshd-session: schickling@pts/39,pts/31,pts/29'] as const },
      {
        comm: 'systemd',
        cmdline: [
          '/run/current-system/systemd/lib/systemd/systemd',
          '--user',
          '--deserialize=21',
        ] as const,
      },
      { comm: '(sd-pam)', cmdline: ['(sd-pam)'] as const },
    ])(
      'does not add a blocker for allowlisted nondumpable $comm',
      async (input) => {
        await observeNondumpable({ ...input, exempt: true })
      },
      30_000,
    )

    it('blocks an unrelated nondumpable process', async () => {
      await observeNondumpable({
        comm: 'reader-fixture',
        cmdline: ['reader-fixture'],
        exempt: false,
      })
    }, 30_000)

    it.each(['sshd-session', 'systemd', '(sd-pam)'])(
      'blocks matching comm %s with the wrong cmdline',
      async (comm) => {
        await observeNondumpable({ comm, cmdline: ['unrelated-reader-command'], exempt: false })
      },
      30_000,
    )
  },
)

describe.skipIf(process.platform !== 'linux')('real exited Linux reader processes', () => {
  it.each(['zombie', 'exit-race'] as const)(
    'does not add a blocker for a confirmed %s process',
    async (mode) => {
      const helper = requireHelper()
      const root = mkdtempSync(join(tmpdir(), 'editor-reader-exited-'))
      const parent = spawn(helper, [], {
        argv0: '(sd-pam)',
        env: {
          ...process.env,
          EDITOR_VIEW_READER_TEST_COMM: '(sd-pam)',
          EDITOR_VIEW_READER_TEST_MODE: mode,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let childPid: number | undefined
      let hookTriggered = false
      let cleanupError: unknown
      try {
        childPid = await new Promise<number>((resolve, reject) => {
          let output = ''
          let diagnostics = ''
          parent.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString()
            const match = /^ready ([0-9]+)\n$/.exec(output)
            if (match?.[1] !== undefined) resolve(Number(match[1]))
          })
          parent.stderr.on('data', (chunk: Buffer) => {
            diagnostics += chunk.toString()
          })
          parent.once('error', reject)
          parent.once('exit', (code, signal) => {
            reject(new Error(`exited-process fixture failed: ${code}/${signal}: ${diagnostics}`))
          })
        })
        const pid = childPid
        const base = `/proc/${pid}`
        expect(readFileSync(join(base, 'comm'), 'utf8').trimEnd()).toBe('exited-reader')
        if (mode === 'zombie') {
          const stat = readFileSync(join(base, 'stat'), 'utf8')
          expect(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z')
          expect(() => readlinkSync(join(base, 'cwd'))).toThrowError(
            expect.objectContaining({ code: expect.stringMatching(/^(EACCES|ENOENT)$/) }),
          )
        } else {
          // Only schedule the real exit. Every stat/readlink result still comes
          // from the kernel; neither permissions nor disappearance is mocked.
          // The C parent eagerly waitpids, allowing synchronous procfs proof
          // even while the JS scanner has not returned to its event loop.
          scheduling.beforeReadlink = (path) => {
            if (path !== join(base, 'cwd') || hookTriggered === true) return
            hookTriggered = true
            process.kill(pid, 'SIGKILL')
            const deadline = Date.now() + 5_000
            const pause = new Int32Array(new SharedArrayBuffer(4))
            for (;;) {
              try {
                readFileSync(join(base, 'stat'))
              } catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break
                throw error
              }
              if (Date.now() >= deadline) throw new Error('native parent did not reap exited child')
              Atomics.wait(pause, 0, 0, 1)
            }
          }
        }
        const candidate = {
          key: 'exited-reader-generation',
          editorRoot: join(root, '.editor-view'),
          snapshotRoot: join(root, '.editor-view', '.store', 'default-test'),
          linkedInodes: [],
        }
        const evidence = classifyEditorViewProcessCandidates({ candidates: [candidate] }).get(
          candidate.key,
        )
        expect(evidence).toBeDefined()
        if (mode === 'exit-race') expect(hookTriggered).toBe(true)
        expect(
          evidence?.reasons.filter(
            (reason) => reason.includes(`${base}/`) || reason.includes(`${base}:`),
          ),
        ).toEqual([])
        if (mode === 'exit-race') {
          expect(() => readFileSync(join(base, 'stat'))).toThrowError(
            expect.objectContaining({ code: 'ENOENT' }),
          )
        }
      } finally {
        delete scheduling.beforeReadlink
        if (mode === 'exit-race' && childPid !== undefined && hookTriggered === false) {
          try {
            process.kill(childPid, 'SIGKILL')
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
              cleanupError = error
          }
        }
        // Graceful EOF lets the fixture reap its zombie before exiting.
        if (parent.exitCode === null && parent.signalCode === null) {
          const exited = once(parent, 'exit')
          parent.stdin.end()
          await exited
        }
        rmSync(root, { recursive: true, force: true })
      }
      if (cleanupError !== undefined) throw cleanupError
    },
    30_000,
  )
})
