import { afterAll, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverDaemons, reap } from './buck2-daemon-reaper.ts'

const buck2 = process.env['BUCK2_BIN']
if (buck2 === undefined || buck2.length === 0)
  throw new Error('BUCK2_BIN must name the pinned buck2')

// Every daemon this test starts lives under this prefix; the reaper is scoped
// to it so the test can never stop a daemon it did not start.
const scratch = mkdtempSync(join(tmpdir(), 'buck2-daemon-reaper-test-'))
const lspClients: Bun.Subprocess<'pipe', 'ignore', 'ignore'>[] = []

const makeRoot = (name: string) => {
  const root = join(scratch, name)
  mkdirSync(root)
  writeFileSync(
    join(root, '.buckconfig'),
    '[cells]\n  root = .\n[buck2]\n  file_watcher = fs_hash_crawler\n',
  )
  writeFileSync(join(root, '.buckroot'), '')
  return root
}

const buck = (root: string, args: readonly string[]) => {
  const result = Bun.spawnSync([buck2, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0)
    throw new Error(`buck2 ${args.join(' ')} failed in ${root}: ${result.stderr.toString()}`)
}

const daemonAt = (root: string) => discoverDaemons(buck2).find((d) => d.projectRoot === root)

// Process exit and LSP attachment expose no awaitable event to a non-parent;
// poll the real condition with a deadline instead of guessing a delay.
const waitFor = async (description: string, condition: () => boolean, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs
  while (condition() === false) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await Bun.sleep(250)
  }
}

const processExists = (pid: number | undefined) =>
  pid !== undefined && existsSync(`/proc/${pid}`) === true

afterAll(() => {
  for (const client of lspClients) client.stdin.end()
  for (const name of ['idle', 'editor', 'gone'])
    if (existsSync(join(scratch, name)) === true) buck(join(scratch, name), ['kill'])
  rmSync(scratch, { recursive: true, force: true })
})

it('kills only the idle daemon and its forkserver, keeps an editor session, reports a gone root', async () => {
  const idle = makeRoot('idle')
  const editor = makeRoot('editor')
  const gone = makeRoot('gone')
  buck(idle, ['audit', 'cell'])
  buck(gone, ['audit', 'cell'])
  lspClients.push(
    Bun.spawn([buck2, 'lsp'], { cwd: editor, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' }),
  )
  await waitFor('the editor session to be active', () => {
    const daemon = daemonAt(editor)
    return daemon !== undefined && daemon.activeCommandCount > 0
  })
  const idleDaemon = daemonAt(idle)
  const goneDaemon = daemonAt(gone)
  const editorDaemon = daemonAt(editor)
  if (idleDaemon === undefined || goneDaemon === undefined || editorDaemon === undefined)
    throw new Error('expected three scratch daemons')
  expect(processExists(idleDaemon.forkserverPid)).toBe(true)

  // A recent command keeps the daemon for the whole threshold.
  const early = reap({
    buck2,
    idleThresholdMs: 60 * 60 * 1000,
    rootPrefixes: [`${scratch}/`],
    dryRun: false,
  })
  expect(early.find((entry) => entry.projectRoot === idle)?.decision).toBe('keep-recent')

  renameSync(gone, `${gone}.moved`)
  try {
    // An hour later the idle root's last command is older than the threshold.
    const entries = reap({
      buck2,
      idleThresholdMs: 5000,
      rootPrefixes: [`${scratch}/`],
      dryRun: false,
      now: () => Date.now() + 60 * 60 * 1000,
    })
    const byRoot = new Map(entries.map((entry) => [entry.projectRoot, entry]))
    expect(byRoot.get(idle)?.outcome?._tag).toBe('killed')
    expect(byRoot.get(editor)?.decision).toBe('keep-active')
    expect(byRoot.get(gone)).toMatchObject({
      decision: 'report-gone',
      pid: goneDaemon.pid,
      daemonId: goneDaemon.daemonId,
      outcome: undefined,
    })
    expect(byRoot.get(gone)?.memoryKiB).toBeGreaterThan(0)
  } finally {
    renameSync(`${gone}.moved`, gone)
  }

  await waitFor(
    'the idle daemon and its forkserver to exit',
    () =>
      processExists(idleDaemon.pid) === false && processExists(idleDaemon.forkserverPid) === false,
  )
  expect(processExists(editorDaemon.pid)).toBe(true)
  expect(processExists(goneDaemon.pid)).toBe(true)
}, 180_000)
