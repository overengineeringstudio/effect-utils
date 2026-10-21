import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyEditorViewProcessCandidates } from './editor-view-readers.ts'
import { isLinuxReaderInfrastructureIdentity } from './reader-infrastructure.ts'

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
