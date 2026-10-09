/**
 * Neutral build-output budget activity admission.
 *
 * Manifests are real files read through the real filesystem; builtin capture
 * runs the real PTY CLI against scoped registries and scans the real `/proc`.
 * Every inadmissible manifest must collapse to `undefined` (unknown ⇒ keep),
 * and a configured manifest never falls back to builtin evidence.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { decodeJson, encodeJson } from '../test-utils/mod.ts'
import { parseProcStat, type ProcessIdentity } from './store-inuse.ts'
import {
  PROCESS_SNAPSHOT_PRODUCER,
  WORKSPACE_ACTIVITY_V2_SCHEMA,
  captureProcessActivityManifest,
  isWorkspaceActive,
  readBudgetWorkspaceActivity,
  readBudgetWorktreeInUse,
  writeWorkspaceActivityManifest,
  type BudgetActivityConfig,
} from './store-workspace-activity.ts'

const PRODUCER = 'acceptance-fixture'
const runsAsRoot = process.getuid?.() === 0

const manifest = ({
  workspace,
  capturedAt = Date.now() - 1_000,
  ttlMs = 60_000,
  host = hostname(),
  complete = true,
  errors = [],
  snapshotId = 'snapshot-1',
  producer = PRODUCER,
  processIdentities,
}: {
  workspace: string
  capturedAt?: number
  ttlMs?: number
  host?: string
  complete?: boolean
  errors?: ReadonlyArray<string>
  snapshotId?: string
  producer?: string
  processIdentities?: unknown
}) =>
  encodeJson({
    schemaVersion: WORKSPACE_ACTIVITY_V2_SCHEMA,
    producer: { name: producer, version: 'fixture-v1' },
    epoch: { host, snapshotId, storeIndex: 7 },
    capturedAt: new Date(capturedAt).toISOString(),
    expiresAt: new Date(capturedAt + ttlMs).toISOString(),
    complete,
    errors,
    ...(processIdentities === undefined ? {} : { processIdentities }),
    claims: [
      {
        workspace,
        sources: ['st3-seat', 'pty'],
        agents: ['agent-1'],
        activeRuntimeIds: ['runtime-1'],
        active: true,
      },
    ],
  })

/** Temp root with a canonical workspace and a manifest path inside it. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
  const workspace = `${root}/workspace`
  yield* fs.makeDirectory(workspace)
  return { fs, root, workspace, manifestPath: `${root}/activity.json` }
})

const manifestOnly = (manifestPath: string): BudgetActivityConfig => ({
  manifestPath,
  agentLivenessProducers: [PRODUCER],
  builtin: false,
})

/** Spawn a long-lived holder in `cwd`, resolved once the OS reports it spawned. */
const spawnHolder = (cwd: string): Promise<ChildProcess> => {
  const { promise, resolve, reject } = Promise.withResolvers<ChildProcess>()
  const child = spawn('sleep', ['120'], { cwd, stdio: 'ignore' })
  child.once('spawn', () => resolve(child))
  child.once('error', reject)
  return promise
}

const killHolder = (child: ChildProcess): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  child.once('exit', () => resolve())
  child.kill('SIGKILL')
  return promise
}

const activityModule = fileURLToPath(new URL('./store-workspace-activity.ts', import.meta.url))
const inUseModule = fileURLToPath(new URL('./store-inuse.ts', import.meta.url))
const jsonModule = fileURLToPath(new URL('../test-utils/json.ts', import.meta.url))

/** Only fixture ownership/publication and fixture child processes use sudo. */
const runPrivilegedFixture = (args: ReadonlyArray<string>) => {
  const result = spawnSync('sudo', ['-n', ...args], { encoding: 'utf8', timeout: 120_000 })
  expect(result.status, `sudo fixture failed: ${result.stderr}`).toBe(0)
}

const runActivityFixture = ({
  root,
  code,
  asRoot = false,
}: {
  root: string
  code: string
  asRoot?: boolean
}) => {
  const result = spawnSync(
    'sudo',
    [
      '-n',
      ...(asRoot === true ? [] : ['-u', 'nobody']),
      '/usr/bin/env',
      `PATH=${process.env['PATH'] ?? ''}`,
      'MEGAREPO_GC_PTY_BIN=pty',
      `PTY_ROOT=${root}/pty`,
      `HOME=${root}/pty`,
      'bun',
      '--eval',
      `
        import { spawn } from 'node:child_process'
        import { NodeServices, Effect, FileSystem, parseProcStat, parseProcUids, readWorktreeReferencesInUse, PROCESS_SNAPSHOT_PRODUCER, captureProcessActivityManifest, isWorkspaceActive, readBudgetWorkspaceActivity, readBudgetWorktreeInUse, writeWorkspaceActivityManifest, decodeJson, encodeJson } from ${encodeJson(`${root}/activity-runtime.mjs`)}
        ${code}
      `,
    ],
    { cwd: `${root}/outside`, encoding: 'utf8', timeout: 120_000 },
  )
  expect(result.status, `sudo activity fixture failed: ${result.stderr}`).toBe(0)
  return decodeJson(result.stdout.trim())
}

/** Root protects the manifest ancestry; nobody owns only its empty, real PTY store. */
const trustedFixture = Effect.gen(function* () {
  const f = yield* fixture
  for (const directory of [
    f.workspace,
    `${f.root}/outside`,
    `${f.root}/idle`,
    `${f.root}/fd-workspace/target`,
    `${f.root}/map-workspace/target`,
    `${f.root}/root-workspace`,
  ]) {
    yield* f.fs.makeDirectory(directory, { recursive: true })
    yield* f.fs.chmod(directory, 0o755)
  }
  // Export the actual implementation and dependencies from a scoped readable
  // bundle; nobody never needs access to the private checkout's ancestors.
  const entry = `${f.root}/activity-runtime.ts`
  const runtime = `${f.root}/activity-runtime.mjs`
  yield* f.fs.writeFileString(
    entry,
    `
      export { NodeServices } from ${encodeJson(fileURLToPath(import.meta.resolve('@effect/platform-node')))}
      export { Effect } from ${encodeJson(fileURLToPath(import.meta.resolve('effect')))}
      export * as FileSystem from ${encodeJson(fileURLToPath(import.meta.resolve('effect/FileSystem')))}
      export { parseProcStat, parseProcUids, readWorktreeReferencesInUse } from ${encodeJson(inUseModule)}
      export { PROCESS_SNAPSHOT_PRODUCER, captureProcessActivityManifest, isWorkspaceActive, readBudgetWorkspaceActivity, readBudgetWorktreeInUse, writeWorkspaceActivityManifest } from ${encodeJson(activityModule)}
      export { decodeJson, encodeJson } from ${encodeJson(jsonModule)}
    `,
  )
  const bundled = spawnSync('bun', ['build', entry, '--target=bun', '--outfile', runtime], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  expect(bundled.status, `activity fixture bundle failed: ${bundled.stderr}`).toBe(0)
  yield* f.fs.chmod(runtime, 0o644)
  yield* Effect.acquireRelease(Effect.void, () =>
    Effect.sync(() =>
      runPrivilegedFixture(['chown', '-R', `${process.getuid!()}:${process.getgid!()}`, f.root]),
    ),
  )
  yield* Effect.sync(() => {
    runPrivilegedFixture(['chown', '0:0', f.root])
    runPrivilegedFixture(['chmod', '0755', f.root])
    runPrivilegedFixture([
      'install',
      '-d',
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      '0755',
      `${f.root}/coverage`,
    ])
    runPrivilegedFixture(['install', '-d', '-o', 'nobody', '-m', '0700', `${f.root}/pty`])
  })
  return { ...f, manifestPath: `${f.root}/coverage/activity.json` }
})

/** Open fd and mmap references before dropping to nobody and becoming non-dumpable. */
const spawnCoveredHolder = ({
  cwd,
  file = '',
  mappedFile = '',
  processRoot = '',
}: {
  cwd: string
  file?: string
  mappedFile?: string
  processRoot?: string
}): Promise<{ child: ChildProcess; identity: ProcessIdentity }> => {
  const { promise, resolve, reject } = Promise.withResolvers<{
    child: ChildProcess
    identity: ProcessIdentity
  }>()
  const child = spawn(
    'sudo',
    [
      '-n',
      '/usr/bin/env',
      `PATH=${process.env['PATH'] ?? ''}`,
      'python3',
      '-u',
      '-c',
      `
import ctypes, os, pwd, signal, sys
owner = pwd.getpwnam("nobody")
libc = ctypes.CDLL(None, use_errno=True)
held_file = open(sys.argv[1], "rb") if sys.argv[1] else None
# A raw mmap retains no duplicate fd: this workspace is protected only by maps.
if sys.argv[2]:
    with open(sys.argv[2], "rb") as mapped_file:
        libc.mmap.restype = ctypes.c_void_p
        libc.mmap.argtypes = [
            ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int,
            ctypes.c_int, ctypes.c_int, ctypes.c_long,
        ]
        held_map = libc.mmap(None, os.fstat(mapped_file.fileno()).st_size, 1, 2, mapped_file.fileno(), 0)
        if held_map == ctypes.c_void_p(-1).value:
            raise OSError(ctypes.get_errno(), "mmap")
with open("/proc/self/stat") as stat:
    start_time = stat.read().rsplit(")", 1)[1].split()[19]
if sys.argv[3]:
    os.chroot(sys.argv[3])
    # Keep the host / cwd: only the process root refers to this fixture workspace.
os.setgroups([])
os.setgid(owner.pw_gid)
os.setuid(owner.pw_uid)
if libc.prctl(4, 0, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_DUMPABLE")
print(str(os.getpid()) + ":" + start_time, flush=True)
signal.pause()
`,
      file,
      mappedFile,
      processRoot,
    ],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
    const ready = /^([1-9]\d*):(\d+)\n/u.exec(stdout)
    if (ready !== null) {
      resolve({ child, identity: { pid: Number(ready[1]), startTime: ready[2]! } })
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.once('error', reject)
  child.once('exit', (code) =>
    reject(new Error(`covered holder exited early (${code}): ${stderr}`)),
  )
  return promise
}

const stopCoveredHolder = (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  child.once('exit', () => resolve())
  child.kill('SIGTERM')
  return promise
}

const readOwnerFixture = ({
  root,
  manifestPath,
  candidates,
  hiddenPid,
}: {
  root: string
  manifestPath: string
  candidates: ReadonlyArray<string>
  hiddenPid: number
}) =>
  runActivityFixture({
    root,
    code: `
      const report = await Effect.runPromise(Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const activity = yield* readBudgetWorkspaceActivity({
          fs, config: {
            manifestPath: ${encodeJson(manifestPath)},
            agentLivenessProducers: [PROCESS_SNAPSHOT_PRODUCER], builtin: false,
          },
        })
        const pid = ${hiddenPid}
        const stat = parseProcStat(yield* fs.readFileString('/proc/' + pid + '/stat'))
        const uids = parseProcUids(yield* fs.readFileString('/proc/' + pid + '/status'))
        const denied = yield* Effect.forEach(['cwd', 'root', 'fd', 'maps'], (entry) =>
          (entry === 'cwd' || entry === 'root'
            ? fs.readLink('/proc/' + pid + '/' + entry)
            : entry === 'fd'
              ? fs.readDirectory('/proc/' + pid + '/fd')
              : fs.readFileString('/proc/' + pid + '/maps')
          ).pipe(Effect.option, Effect.map((result) => result._tag === 'None')))
        return {
          admitted: activity !== undefined,
          coverage: activity?.processCoverage,
          identity: { pid, startTime: stat?.startTime },
          ownUid: uids?.every((uid) => uid === process.getuid()),
          denied,
          candidates: yield* Effect.forEach(${encodeJson(candidates)}, (path) =>
            Effect.gen(function* () {
              return {
                path,
                active: activity !== undefined && isWorkspaceActive({
                  activity, canonicalWorktree: path,
                }),
                inUse: yield* readBudgetWorktreeInUse({ worktreePath: path, activity }),
              }
            })),
        }
      }).pipe(Effect.provide(NodeServices.layer)))
      console.log(encodeJson(report))
    `,
  })

/** Isolate the actual PTY registry, without substituting any PTY executable. */
const withRealPty = ({ fs, root }: { fs: FileSystem.FileSystem; root: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      yield* fs.makeDirectory(`${root}/pty`, { recursive: true })
      const previous = {
        root: process.env['PTY_ROOT'],
        bin: process.env['MEGAREPO_GC_PTY_BIN'],
      }
      process.env['PTY_ROOT'] = `${root}/pty`
      process.env['MEGAREPO_GC_PTY_BIN'] = 'pty'
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous.root === undefined) delete process.env['PTY_ROOT']
        else process.env['PTY_ROOT'] = previous.root
        if (previous.bin === undefined) delete process.env['MEGAREPO_GC_PTY_BIN']
        else process.env['MEGAREPO_GC_PTY_BIN'] = previous.bin
      }),
  )

const runPtyFixture = (args: ReadonlyArray<string>) => {
  const result = spawnSync('pty', args, { encoding: 'utf8', timeout: 30_000 })
  expect(result.status, `real PTY fixture failed: ${result.stderr}`).toBe(0)
  return result.stdout.trim()
}

/** Await actual daemon readiness, terminate it, and retain its real exit record. */
const retainExitedPty = Effect.fnUntraced(function* ({ id, cwd }: { id: string; cwd: string }) {
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      runPtyFixture([
        'run',
        '-d',
        '--id',
        id,
        '--tag',
        'keep=true',
        '--cwd',
        cwd,
        '--',
        'sh',
        '-c',
        'echo fixture-ready; exec sleep 120',
      ])
    }),
    () =>
      Effect.sync(() => {
        // An earlier assertion may have failed while this exact fixture was live.
        spawnSync('pty', ['kill', id], { encoding: 'utf8', timeout: 30_000 })
        runPtyFixture(['rm', id])
      }),
  )
  yield* Effect.sync(() => {
    runPtyFixture(['peek', '--wait', 'fixture-ready', '-t', '10', id])
    runPtyFixture(['kill', id])
    expect(decodeJson(runPtyFixture(['list', '--json', '--tags']))).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: id, status: 'exited', cwd })]),
    )
  })
})

describe('readBudgetWorkspaceActivity manifest admission', () => {
  it.live(
    'admits a fresh complete manifest from a listed producer on this host',
    Effect.fnUntraced(
      function* () {
        const { fs, workspace, manifestPath } = yield* fixture
        yield* fs.writeFileString(manifestPath, manifest({ workspace }))
        const activity = yield* readBudgetWorkspaceActivity({
          fs,
          config: manifestOnly(manifestPath),
        })
        expect(activity?.epoch).toEqual({
          host: hostname(),
          producer: PRODUCER,
          snapshotId: 'snapshot-1',
          storeIndex: 7,
        })
        expect([...(activity?.activePaths ?? [])]).toEqual([workspace])
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: workspace })).toBe(true)

        // Re-reading the same producer snapshot stays admitted.
        const again = yield* readBudgetWorkspaceActivity({
          fs,
          config: manifestOnly(manifestPath),
          admittedEpoch: activity!.epoch,
        })
        expect(again?.epoch).toEqual(activity?.epoch)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.live(
    'missing manifest is unknown and never falls back to builtin evidence',
    Effect.fnUntraced(
      function* () {
        const { fs, manifestPath } = yield* fixture
        expect(
          yield* readBudgetWorkspaceActivity({ fs, config: manifestOnly(manifestPath) }),
        ).toBeUndefined()
        expect(
          yield* readBudgetWorkspaceActivity({
            fs,
            config: { manifestPath, agentLivenessProducers: [PRODUCER], builtin: true },
          }),
        ).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.live(
    'rejects expired, future, over-long, foreign-host, incomplete, errored and unlisted manifests',
    Effect.fnUntraced(
      function* () {
        const { fs, workspace, manifestPath } = yield* fixture
        const now = Date.now()
        const rejected = [
          manifest({ workspace, capturedAt: now - 120_000, ttlMs: 60_000 }),
          manifest({ workspace, capturedAt: now + 60_000 }),
          manifest({ workspace, capturedAt: now - 1_000, ttlMs: 5 * 60_000 + 1 }),
          manifest({ workspace, host: `not-${hostname()}` }),
          manifest({ workspace, complete: false }),
          manifest({ workspace, errors: ['st3 agents ls failed'] }),
          manifest({ workspace, producer: 'st2' }),
          encodeJson({ schemaVersion: 'st2.workspace-activity.v1' }),
          '{ not json',
        ]
        for (const content of rejected) {
          yield* fs.writeFileString(manifestPath, content)
          expect(
            yield* readBudgetWorkspaceActivity({ fs, config: manifestOnly(manifestPath) }),
          ).toBeUndefined()
        }
        // No admitted producers admits nothing.
        yield* fs.writeFileString(manifestPath, manifest({ workspace }))
        expect(
          yield* readBudgetWorkspaceActivity({
            fs,
            config: { manifestPath, builtin: false },
          }),
        ).toBeUndefined()
        // No source at all is unknown, not idle.
        expect(
          yield* readBudgetWorkspaceActivity({ fs, config: { builtin: false } }),
        ).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.live(
    'optional process identities must have positive integer pids, decimal-string ticks and unique pids',
    Effect.fnUntraced(
      function* () {
        const { fs, workspace, manifestPath } = yield* fixture
        for (const processIdentities of [
          undefined,
          [],
          [
            { pid: 1, startTime: '0' },
            { pid: 2, startTime: '9007199254740993' },
          ],
        ]) {
          yield* fs.writeFileString(manifestPath, manifest({ workspace, processIdentities }))
          const admitted = yield* readBudgetWorkspaceActivity({
            fs,
            config: manifestOnly(manifestPath),
          })
          expect(admitted).toBeDefined()
          // A user-owned liveness manifest cannot turn identities into process coverage.
          expect(admitted?.processCoverage).toBeUndefined()
        }
        for (const processIdentities of [
          null,
          {},
          [null],
          [{ pid: 0, startTime: '1' }],
          [{ pid: -1, startTime: '1' }],
          [{ pid: 1.5, startTime: '1' }],
          [{ pid: '1', startTime: '1' }],
          [{ startTime: '1' }],
          [{ pid: 1 }],
          [{ pid: 1, startTime: '' }],
          [{ pid: 1, startTime: 1 }],
          [{ pid: 1, startTime: '-1' }],
          [{ pid: 1, startTime: '1.5' }],
          [{ pid: 1, startTime: '1e3' }],
          [{ pid: 1, startTime: ' 1 ' }],
          [{ pid: 1, startTime: 'not-ticks' }],
          [
            { pid: 1, startTime: '1' },
            { pid: 1, startTime: '1' },
          ],
          [
            { pid: 1, startTime: '1' },
            { pid: 1, startTime: '2' },
          ],
        ]) {
          yield* fs.writeFileString(manifestPath, manifest({ workspace, processIdentities }))
          expect(
            yield* readBudgetWorkspaceActivity({ fs, config: manifestOnly(manifestPath) }),
          ).toBeUndefined()
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.live(
    'a changed producer snapshot after the scan is unknown',
    Effect.fnUntraced(
      function* () {
        const { fs, workspace, manifestPath } = yield* fixture
        yield* fs.writeFileString(manifestPath, manifest({ workspace }))
        const admitted = yield* readBudgetWorkspaceActivity({
          fs,
          config: manifestOnly(manifestPath),
        })
        yield* fs.writeFileString(manifestPath, manifest({ workspace, snapshotId: 'snapshot-2' }))
        expect(
          yield* readBudgetWorkspaceActivity({
            fs,
            config: manifestOnly(manifestPath),
            admittedEpoch: admitted!.epoch,
          }),
        ).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.live(
    'noncanonical claims are unknown; claims for deleted workspaces protect nothing',
    Effect.fnUntraced(
      function* () {
        const { fs, root, workspace, manifestPath } = yield* fixture
        yield* fs.symlink(workspace, `${root}/alias`)
        yield* fs.writeFileString(manifestPath, manifest({ workspace: `${root}/alias` }))
        expect(
          yield* readBudgetWorkspaceActivity({ fs, config: manifestOnly(manifestPath) }),
        ).toBeUndefined()

        yield* fs.writeFileString(manifestPath, manifest({ workspace: `${root}/gone` }))
        const activity = yield* readBudgetWorkspaceActivity({
          fs,
          config: manifestOnly(manifestPath),
        })
        expect(activity?.activePaths.size).toBe(0)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

describe.skipIf(process.platform !== 'linux')('readBudgetWorkspaceActivity builtin capture', () => {
  it.live(
    'is unknown when another owner’s process cannot be inspected',
    Effect.fnUntraced(
      function* () {
        if (runsAsRoot === true) return
        const { fs, root } = yield* fixture
        yield* withRealPty({ fs, root })
        // PID 1 belongs to root: its cwd/root/fds are unreadable to this user.
        expect(yield* readBudgetWorkspaceActivity({ fs, config: {} })).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.live.skipIf(runsAsRoot === false)(
    'retained PTY records and live process references protect their worktrees',
    Effect.fnUntraced(
      function* () {
        const { fs, root, workspace } = yield* fixture
        const ptyWorkspace = `${root}/pty-workspace`
        const idle = `${root}/idle`
        yield* fs.makeDirectory(ptyWorkspace)
        yield* fs.makeDirectory(idle)
        yield* withRealPty({ fs, root })
        yield* retainExitedPty({ id: 'mr-budget.retained', cwd: ptyWorkspace })
        const deletedWorkspace = `${root}/deleted`
        yield* fs.makeDirectory(deletedWorkspace)
        yield* retainExitedPty({ id: 'mr-budget.deleted', cwd: deletedWorkspace })
        yield* fs.remove(deletedWorkspace)
        const holder = yield* Effect.promise(() => spawnHolder(workspace))
        const activity = yield* readBudgetWorkspaceActivity({ fs, config: {} })
        yield* Effect.promise(() => killHolder(holder))

        expect(activity?.epoch.producer).toBe('builtin')
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: ptyWorkspace })).toBe(
          true,
        )
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: workspace })).toBe(true)
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: idle })).toBe(false)

        // A missing real PTY executable makes builtin evidence unavailable.
        process.env['MEGAREPO_GC_PTY_BIN'] = `${root}/missing-pty`
        expect(yield* readBudgetWorkspaceActivity({ fs, config: {} })).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 120_000 },
  )
})

describe.skipIf(process.platform !== 'linux')('all-uid process coverage', () => {
  it.live(
    'a root-controlled snapshot admits exact unreadable own-UID lifetimes, preserves every kernel claim and rejects uncovered lifetimes',
    Effect.fnUntraced(
      function* () {
        const { fs, root, workspace, manifestPath } = yield* trustedFixture
        const fdWorkspace = `${root}/fd-workspace`
        const mapWorkspace = `${root}/map-workspace`
        const rootWorkspace = `${root}/root-workspace`
        const idle = `${root}/idle`
        const file = `${fdWorkspace}/target/artifact`
        const mappedFile = `${mapWorkspace}/target/artifact`
        yield* fs.writeFileString(file, 'open fd bytes')
        yield* fs.writeFileString(mappedFile, 'mapped bytes')
        const hidden = yield* Effect.acquireRelease(
          Effect.promise(() => spawnCoveredHolder({ cwd: workspace, file, mappedFile })),
          ({ child }) => Effect.promise(() => stopCoveredHolder(child)),
        )
        const rooted = yield* Effect.acquireRelease(
          Effect.promise(() => spawnCoveredHolder({ cwd: '/', processRoot: rootWorkspace })),
          ({ child }) => Effect.promise(() => stopCoveredHolder(child)),
        )
        const unrelated = yield* Effect.acquireRelease(
          Effect.promise(() => spawnCoveredHolder({ cwd: '/' })),
          ({ child }) => Effect.promise(() => stopCoveredHolder(child)),
        )
        expect(
          runActivityFixture({
            root,
            asRoot: true,
            code: `
              await Effect.runPromise(Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem
                const snapshot = yield* captureProcessActivityManifest({
                  fs, storeRoots: [${encodeJson(root)}],
                })
                yield* writeWorkspaceActivityManifest({
                  fs, path: ${encodeJson(manifestPath)}, manifest: snapshot,
                })
              }).pipe(Effect.provide(NodeServices.layer)))
              console.log(encodeJson(true))
            `,
          }),
        ).toBe(true)
        const snapshot = yield* fs.readFileString(manifestPath)
        expect(decodeJson(snapshot)).toMatchObject({
          complete: true,
          errors: [],
          processCoverage: 'all-uids',
          processRoots: [root],
          // No store reference is required for an identity to be covered.
          processIdentities: expect.arrayContaining([
            hidden.identity,
            rooted.identity,
            unrelated.identity,
          ]),
          claims: expect.arrayContaining(
            [workspace, `${fdWorkspace}/target`, `${mapWorkspace}/target`, rootWorkspace].map(
              (path) => ({
                workspace: path,
                sources: ['process'],
                agents: [],
                activeRuntimeIds: [],
                active: true,
              }),
            ),
          ),
        })
        const candidates = [workspace, fdWorkspace, mapWorkspace, rootWorkspace, idle]
        const admitted = readOwnerFixture({
          root,
          manifestPath,
          candidates,
          hiddenPid: hidden.identity.pid,
        })
        expect(admitted).toMatchObject({
          admitted: true,
          identity: hidden.identity,
          ownUid: true,
          denied: [true, true, true, true],
          coverage: {
            roots: [root],
            processIdentities: expect.arrayContaining([
              hidden.identity,
              rooted.identity,
              unrelated.identity,
            ]),
          },
          candidates: [
            ...[workspace, fdWorkspace, mapWorkspace, rootWorkspace].map((path) => ({
              path,
              active: true,
              inUse: { _tag: 'free' },
            })),
            { path: idle, active: false, inUse: { _tag: 'free' } },
          ],
        })

        // Root ownership and freshness do not waive an absent or mismatched lifetime.
        for (const mutation of [
          'delete value.processIdentities',
          'value.processIdentities = []',
          `value.processIdentities = value.processIdentities.filter((identity) => identity.pid !== ${hidden.identity.pid})`,
          `value.processIdentities = value.processIdentities.map((identity) => identity.pid === ${hidden.identity.pid} ? { ...identity, startTime: String(BigInt(identity.startTime) + 1n) } : identity)`,
          `value.processIdentities.push(${encodeJson(hidden.identity)})`,
          `value.processIdentities.push({ ...${encodeJson(hidden.identity)}, startTime: String(BigInt(${encodeJson(hidden.identity.startTime)}) + 1n) })`,
          "value.processIdentities.push({ pid: 1, startTime: 'not-ticks' })",
          'value.capturedAt = new Date(Date.now() - 2000).toISOString(); value.expiresAt = new Date(Date.now() - 1000).toISOString()',
        ]) {
          expect(
            runActivityFixture({
              root,
              asRoot: true,
              code: `
                const value = decodeJson(${encodeJson(snapshot)})
                ${mutation}
                await Effect.runPromise(Effect.gen(function* () {
                  const fs = yield* FileSystem.FileSystem
                  yield* fs.writeFileString(${encodeJson(manifestPath)}, encodeJson(value))
                }).pipe(Effect.provide(NodeServices.layer)))
                console.log(encodeJson(true))
              `,
            }),
          ).toBe(true)
          expect(
            readOwnerFixture({
              root,
              manifestPath,
              candidates: [idle],
              hiddenPid: hidden.identity.pid,
            }),
          ).toMatchObject({
            admitted: false,
            candidates: [
              {
                path: idle,
                inUse: { _tag: 'unknown', reason: 'inaccessible-process' },
              },
            ],
          })
        }
        expect(
          runActivityFixture({
            root,
            asRoot: true,
            code: `
              await Effect.runPromise(Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem
                yield* fs.writeFileString(${encodeJson(manifestPath)}, ${encodeJson(snapshot)})
              }).pipe(Effect.provide(NodeServices.layer)))
              console.log(encodeJson(true))
            `,
          }),
        ).toBe(true)

        // Admit first, then start a new same-UID non-dumpable process. Both fresh
        // owner capture and deletion-time rechecks must fail closed on its identity.
        const late = runActivityFixture({
          root,
          code: `
            const report = await Effect.runPromise(Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem
              const config = {
                manifestPath: ${encodeJson(manifestPath)},
                agentLivenessProducers: [PROCESS_SNAPSHOT_PRODUCER], builtin: false,
              }
              const admitted = yield* readBudgetWorkspaceActivity({ fs, config })
              const child = yield* Effect.acquireRelease(
                Effect.promise(() => {
                  const { promise, resolve, reject } = Promise.withResolvers()
                  const child = spawn('python3', ['-u', '-c', ${encodeJson(`
import ctypes, os, signal
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(4, 0, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_DUMPABLE")
print("ready", flush=True)
signal.pause()
`)}], { cwd: ${encodeJson(`${root}/outside`)}, stdio: ['ignore', 'pipe', 'pipe'] })
                  let stdout = ''
                  child.stdout.on('data', (chunk) => {
                    stdout += chunk.toString()
                    if (stdout.includes('ready\\n')) resolve(child)
                  })
                  child.once('error', reject)
                  child.once('exit', (code) => reject(new Error('late holder exited early: ' + code)))
                  return promise
                }),
                (child) => Effect.promise(() => {
                  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
                  const { promise, resolve } = Promise.withResolvers()
                  child.once('exit', resolve)
                  child.kill('SIGKILL')
                  return promise
                }),
              )
              const stat = parseProcStat(yield* fs.readFileString('/proc/' + child.pid + '/stat'))
              return {
                admittedBeforeLate: admitted !== undefined,
                coveredLate: admitted?.processCoverage?.processIdentities.some(
                  (identity) => identity.pid === child.pid && identity.startTime === stat?.startTime),
                admittedAfterLate: (yield* readBudgetWorkspaceActivity({ fs, config })) !== undefined,
                deletionRecheck: yield* readBudgetWorktreeInUse({
                  worktreePath: ${encodeJson(idle)}, activity: admitted,
                }),
              }
            }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
            console.log(encodeJson(report))
          `,
        })
        expect(late).toMatchObject({
          admittedBeforeLate: true,
          coveredLate: false,
          admittedAfterLate: false,
          deletionRecheck: { _tag: 'unknown', reason: 'inaccessible-process' },
        })
        // Once only the covered lifetimes remain, the same snapshot is usable again.
        expect(
          readOwnerFixture({
            root,
            manifestPath,
            candidates: [idle],
            hiddenPid: hidden.identity.pid,
          }),
        ).toMatchObject({
          admitted: true,
          candidates: [{ path: idle, active: false, inUse: { _tag: 'free' } }],
        })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 120_000 },
  )

  it.live.skipIf(runsAsRoot === true)(
    'an all-uid manifest the owner could have written is rejected; strict probe stays unknown',
    Effect.fnUntraced(
      function* () {
        const { fs, root, workspace, manifestPath } = yield* fixture
        yield* withRealPty({ fs, root })
        const forged = yield* captureProcessActivityManifest({ fs, storeRoots: [root] })
        // Non-root cannot read every process: the snapshot reports itself incomplete.
        expect(forged.complete).toBe(false)
        // Publication refuses a directory the owner controls.
        const refused = yield* writeWorkspaceActivityManifest({
          fs,
          path: manifestPath,
          manifest: { ...forged, complete: true, errors: [] },
        }).pipe(Effect.flip)
        expect(refused._tag).toBe('ActivityUnavailable')
        expect(yield* fs.readDirectory(root)).not.toContainEqual(expect.stringMatching(/\.tmp$/))
        // A hand-written copy is rejected by readers for the same reason.
        yield* fs.writeFileString(
          manifestPath,
          encodeJson({
            ...(decodeJson(manifest({ workspace })) as object),
            processCoverage: 'all-uids',
            processRoots: [root],
            processIdentities: forged.processIdentities,
          }),
        )
        expect(
          yield* readBudgetWorkspaceActivity({
            fs,
            config: {
              manifestPath,
              agentLivenessProducers: [PRODUCER],
              builtin: false,
            },
          }),
        ).toBeUndefined()
        expect(
          yield* readBudgetWorktreeInUse({ worktreePath: workspace, activity: undefined }),
        ).toEqual({ _tag: 'unknown', reason: 'inaccessible-process' })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.live.skipIf(runsAsRoot === false)(
    'a root snapshot covers processes; the owner still adds fresh PTY records',
    Effect.fnUntraced(
      function* () {
        const { fs, root, workspace, manifestPath } = yield* fixture
        const ptyWorkspace = `${root}/pty-workspace`
        const idle = `${root}/idle`
        yield* fs.makeDirectory(ptyWorkspace)
        yield* fs.makeDirectory(idle)
        const holder = yield* Effect.promise(() => spawnHolder(workspace))
        const unrelatedCwd = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
        const unrelatedHolder = yield* Effect.acquireRelease(
          Effect.promise(() => spawnHolder(unrelatedCwd)),
          (child) => Effect.promise(() => killHolder(child)),
        )
        const snapshot = yield* captureProcessActivityManifest({ fs, storeRoots: [root] })
        for (const child of [holder, unrelatedHolder]) {
          const stat = parseProcStat(yield* fs.readFileString(`/proc/${child.pid!}/stat`))
          expect(snapshot.processIdentities).toContainEqual({
            pid: child.pid,
            startTime: stat?.startTime,
          })
        }
        expect(snapshot.claims.some((claim) => claim.workspace === unrelatedCwd)).toBe(false)
        yield* Effect.promise(() => killHolder(holder))

        expect(snapshot).toMatchObject({
          producer: { name: PROCESS_SNAPSHOT_PRODUCER },
          complete: true,
          errors: [],
          processCoverage: 'all-uids',
          processRoots: [root],
        })
        expect(snapshot.claims).toContainEqual({
          workspace,
          sources: ['process'],
          agents: [],
          activeRuntimeIds: [],
          active: true,
        })
        yield* writeWorkspaceActivityManifest({ fs, path: manifestPath, manifest: snapshot })

        yield* withRealPty({ fs, root })
        yield* retainExitedPty({ id: 'mr-budget.retained', cwd: ptyWorkspace })
        const config = {
          manifestPath,
          agentLivenessProducers: [PROCESS_SNAPSHOT_PRODUCER],
          builtin: false,
        }
        const activity = yield* readBudgetWorkspaceActivity({ fs, config })
        expect(activity?.processCoverage).toEqual({
          roots: [root],
          processIdentities: snapshot.processIdentities,
        })
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: workspace })).toBe(true)
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: ptyWorkspace })).toBe(
          true,
        )
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: idle })).toBe(false)
        expect(yield* readBudgetWorktreeInUse({ worktreePath: idle, activity })).toEqual({
          _tag: 'free',
        })

        // A fresh root-controlled snapshot from a previous boot cannot waive
        // foreign-process inspection, nor can a nonzero native store index.
        for (const epoch of [
          { ...snapshot.epoch, snapshotId: 'previous-boot' },
          { ...snapshot.epoch, storeIndex: 1 },
        ]) {
          yield* writeWorkspaceActivityManifest({
            fs,
            path: manifestPath,
            manifest: { ...snapshot, epoch },
          })
          expect(yield* readBudgetWorkspaceActivity({ fs, config })).toBeUndefined()
        }
        yield* writeWorkspaceActivityManifest({ fs, path: manifestPath, manifest: snapshot })

        // The PTY supplement is mandatory: its failure makes the manifest unusable.
        process.env['MEGAREPO_GC_PTY_BIN'] = `${root}/missing-pty`
        expect(yield* readBudgetWorkspaceActivity({ fs, config })).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 120_000 },
  )
})
