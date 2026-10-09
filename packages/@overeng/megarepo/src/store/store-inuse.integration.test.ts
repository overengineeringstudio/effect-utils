/**
 * Live-process in-use probe tests.
 *
 * The pure classifier and lsof parser are exercised directly, and the native
 * process-table reader against a REAL spawned holder whose cwd is inside a temp
 * worktree — the incident shape: a live session sitting in a directory that
 * reclamation is about to rename. These cases deliberately drive real OS
 * processes, because the probe's whole job is to observe them; process
 * lifecycle is awaited through node's `spawn`/`exit` events, never a timer, so
 * no wall-clock guessing is involved.
 *
 * `selfPid` is passed as a sibling process's pid in the observable case: a
 * sibling is never an ancestor of the holder, so the descendant walk never
 * excludes it. That models production, where gc is its own process tree rather
 * than an ancestor of the live session.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { decodeJson, encodeJson } from '../test-utils/mod.ts'
import {
  classifyInUse,
  isInsideWorktree,
  parseLsofProcessCwds,
  parseProcMapsPaths,
  parseProcStat,
  parseProcUids,
  readProcessReferences,
  readWorktreeInUse,
  readWorktreeReferencesInUse,
  type ProcessIdentity,
} from './store-inuse.ts'

const supportsProcessCwdProbe = process.platform === 'linux' || process.platform === 'darwin'
const runsAsRoot = process.getuid?.() === 0

/** Spawn a long-lived holder in `cwd`, resolved once the OS reports it spawned. */
const spawnHolder = (cwd: string): Promise<ChildProcess> => {
  const { promise, resolve, reject } = Promise.withResolvers<ChildProcess>()
  const child = spawn('sleep', ['120'], { cwd, stdio: 'ignore' })
  child.once('spawn', () => resolve(child))
  child.once('error', reject)
  return promise
}

/** Kill a holder and resolve on its real `exit` event. */
const killHolder = (child: ChildProcess): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  child.once('exit', () => resolve())
  child.kill('SIGKILL')
  return promise
}

/** A holder whose cwd is elsewhere but which keeps `file` open on fd 3. */
const spawnFdHolder = ({ cwd, file }: { cwd: string; file: string }): Promise<ChildProcess> => {
  const { promise, resolve, reject } = Promise.withResolvers<ChildProcess>()
  const child = spawn('sh', ['-c', 'exec 3<"$1"; exec sleep 120', 'holder', file], {
    cwd,
    stdio: 'ignore',
  })
  child.once('spawn', () => resolve(child))
  child.once('error', reject)
  return promise
}

/** All privileged commands below operate only on holders or their scoped fixture. */
const referenceModule = fileURLToPath(new URL('./store-inuse.ts', import.meta.url))
const jsonModule = fileURLToPath(new URL('../test-utils/json.ts', import.meta.url))
const ProcessIdentities = Schema.Array(
  Schema.Struct({ pid: Schema.Number, startTime: Schema.String }),
)

const runReferenceFixture = ({
  cwd,
  code,
  asRoot = false,
}: {
  cwd: string
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
      'bun',
      '--eval',
      `
        import { NodeServices } from ${encodeJson(import.meta.resolve('@effect/platform-node'))}
        import { Effect } from ${encodeJson(import.meta.resolve('effect'))}
        import * as FileSystem from ${encodeJson(import.meta.resolve('effect/FileSystem'))}
        import { parseProcStat, parseProcUids, readProcessReferences, readWorktreeReferencesInUse } from ${encodeJson(referenceModule)}
        import { encodeJson } from ${encodeJson(jsonModule)}
        ${code}
      `,
    ],
    { cwd, encoding: 'utf8', timeout: 120_000 },
  )
  expect(result.status, `sudo fixture failed: ${result.stderr}`).toBe(0)
  return decodeJson(result.stdout.trim())
}

/** PR_SET_DUMPABLE=0 denies even same-UID cwd/root/fd/maps reads, but not stat. */
const spawnIdentityHolder = ({
  cwd,
  nonDumpable = true,
}: {
  cwd: string
  nonDumpable?: boolean
}): Promise<{ child: ChildProcess; identity: ProcessIdentity }> => {
  const { promise, resolve, reject } = Promise.withResolvers<{
    child: ChildProcess
    identity: ProcessIdentity
  }>()
  const child = spawn(
    'sudo',
    [
      '-n',
      '-u',
      'nobody',
      '/usr/bin/env',
      `PATH=${process.env['PATH'] ?? ''}`,
      'python3',
      '-u',
      '-c',
      `
import ctypes, os, signal
if ${nonDumpable === true ? 'True' : 'False'}:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_DUMPABLE")
with open("/proc/self/stat") as stat:
    start_time = stat.read().rsplit(")", 1)[1].split()[19]
print(str(os.getpid()) + ":" + start_time, flush=True)
signal.pause()
`,
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
    reject(new Error(`identity holder exited early (${code}): ${stderr}`)),
  )
  return promise
}

/** sudo relays SIGTERM to its fixture child; never signal an unrelated process. */
const stopIdentityHolder = (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  child.once('exit', () => resolve())
  child.kill('SIGTERM')
  return promise
}

describe('store-inuse classifier', () => {
  it('parses macOS lsof cwd records with their parent process identities', () => {
    expect(
      parseLsofProcessCwds([
        'p100',
        'R1',
        'fcwd',
        'n/store/repo',
        'p101',
        'R100',
        'fcwd',
        'n/store/repo/src',
        'pnot-a-pid',
        'R101',
        'fcwd',
        'n/ignored',
      ]),
    ).toEqual([
      { pid: 100, parentPid: 1, path: '/store/repo' },
      { pid: 101, parentPid: 100, path: '/store/repo/src' },
    ])
  })

  it('treats the worktree and its descendants as inside, siblings as outside', () => {
    const worktree = '/store/repo/refs/heads/main'
    expect(isInsideWorktree({ candidate: worktree, worktreePath: `${worktree}/` })).toBe(true)
    expect(isInsideWorktree({ candidate: `${worktree}/src/app`, worktreePath: worktree })).toBe(
      true,
    )
    // The bug a raw string prefix would introduce: a sibling directory.
    expect(isInsideWorktree({ candidate: `${worktree}.archive-old`, worktreePath: worktree })).toBe(
      false,
    )
    expect(
      isInsideWorktree({ candidate: '/store/repo/refs/heads/other', worktreePath: worktree }),
    ).toBe(false)
  })

  it('reports the first non-excluded holder and ignores excluded pids', () => {
    const worktreePath = '/store/repo/refs/heads/main'
    const processes = [
      { pid: 10, path: '/elsewhere' },
      { pid: 11, path: `${worktreePath}/src` },
      { pid: 12, path: worktreePath },
    ]

    expect(classifyInUse({ processes, worktreePath, excludePids: new Set() })).toEqual({
      _tag: 'in-use',
      holder: { pid: 11, path: `${worktreePath}/src` },
    })
    expect(classifyInUse({ processes, worktreePath, excludePids: new Set([11]) })).toEqual({
      _tag: 'in-use',
      holder: { pid: 12, path: worktreePath },
    })
    expect(classifyInUse({ processes, worktreePath, excludePids: new Set([11, 12]) })).toEqual({
      _tag: 'free',
    })
  })

  it('parses parent pid, kernel-thread flag and exact field-22 ticks past a comm with spaces and parens', () => {
    expect(
      parseProcStat(`42 (a) b (c)) S 7 42 42 0 -1 4194560 ${'0 '.repeat(12)}9007199254740993`),
    ).toEqual({
      parentPid: 7,
      kernelThread: false,
      startTime: '9007199254740993',
    })
    expect(parseProcStat(`2 (kthreadd) S 0 0 0 0 -1 2129984 ${'0 '.repeat(12)}0`)).toEqual({
      parentPid: 0,
      kernelThread: true,
      startTime: '0',
    })
    expect(parseProcStat('42 (truncated) S 7 42 42 0 -1 4194560')).toBeUndefined()
    for (const startTime of ['-1', '1.5', 'not-ticks']) {
      expect(
        parseProcStat(`42 (holder) S 7 42 42 0 -1 4194560 ${'0 '.repeat(12)}${startTime}`),
      ).toBeUndefined()
    }
    expect(parseProcStat('garbage')).toBeUndefined()
  })

  it('extracts mapped file paths, including deleted ones, and skips anonymous maps', () => {
    expect(
      parseProcMapsPaths(
        [
          '00400000-00452000 r-xp 00000000 08:02 173521 /usr/bin/dbus-daemon',
          '7f00-7f01 rw-p 00000000 00:00 0 ',
          '7f01-7f02 rw-p 00000000 00:00 0 [heap]',
          '7f02-7f03 r--p 00000000 08:02 99 /store/repo/target/lib name.so (deleted)',
        ].join('\n'),
      ),
    ).toEqual(['/usr/bin/dbus-daemon', '/store/repo/target/lib name.so'])
  })

  it('parses the four status uids and rejects malformed lines', () => {
    expect(parseProcUids('Name:\tsleep\nUid:\t1000\t1000\t1000\t1000\nGid:\t100\n')).toEqual([
      1000, 1000, 1000, 1000,
    ])
    expect(parseProcUids('Uid:\t1000\t0\t1000\t0\n')).toEqual([1000, 0, 1000, 0])
    expect(parseProcUids('Uid:\t1000\n')).toBeUndefined()
    expect(parseProcUids('Name:\tsleep\n')).toBeUndefined()
  })
})

describe.skipIf(supportsProcessCwdProbe === false)('store-inuse native process probe', () => {
  it.effect(
    'sees a live holder inside the worktree, and frees once it exits',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const root = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const worktree = EffectPath.ops.join(root, EffectPath.unsafe.relativeDir('worktree/'))
        const sibling = EffectPath.ops.join(root, EffectPath.unsafe.relativeDir('worktree-old/'))
        yield* fs.makeDirectory(worktree, { recursive: true })
        yield* fs.makeDirectory(sibling, { recursive: true })

        const holder = yield* Effect.promise(() => spawnHolder(worktree))
        const standIn = yield* Effect.promise(() => spawnHolder(root))

        const occupied = yield* readWorktreeInUse({
          worktreePath: worktree,
          selfPid: standIn.pid!,
        })
        expect(occupied).toMatchObject({ _tag: 'in-use', holder: { pid: holder.pid } })

        // The sibling directory is not the worktree, so it reads free.
        const siblingResult = yield* readWorktreeInUse({
          worktreePath: sibling,
          selfPid: standIn.pid!,
        })
        expect(siblingResult._tag).toBe('free')

        yield* Effect.promise(() => killHolder(holder))
        yield* Effect.promise(() => killHolder(standIn))

        const freed = yield* readWorktreeInUse({ worktreePath: worktree, selfPid: 1 })
        expect(freed._tag).toBe('free')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'never vetoes on its own descendants',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const worktree = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        // A descendant of this process, exactly like a `git` child megarepo
        // spawns inside the worktree it is reclaiming.
        const child = yield* Effect.promise(() => spawnHolder(worktree))
        const result = yield* readWorktreeInUse({ worktreePath: worktree })
        yield* Effect.promise(() => killHolder(child))
        expect(result._tag).toBe('free')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

describe.skipIf(process.platform !== 'linux')('store-inuse strict reference probe', () => {
  it.effect.skipIf(runsAsRoot === true)(
    'an unreadable process of another owner makes the probe unknown',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const worktree = yield* fs.makeTempDirectoryScoped()
        // PID 1 is root-owned; its cwd/root/fds are unreadable to this user.
        expect(yield* readWorktreeReferencesInUse({ worktreePath: worktree })).toEqual({
          _tag: 'unknown',
          reason: 'inaccessible-process',
        })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.live(
    'only exact root-scanned identities cover unreadable own-UID processes; new readable references are still scanned',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
        const worktree = `${root}/worktree`
        const outside = `${root}/outside`
        for (const directory of [root, worktree, outside]) {
          yield* fs.makeDirectory(directory, { recursive: true })
          yield* fs.chmod(directory, 0o755)
        }
        const hidden = yield* Effect.acquireRelease(
          Effect.promise(() => spawnIdentityHolder({ cwd: outside })),
          ({ child }) => Effect.promise(() => stopIdentityHolder(child)),
        )
        const coveredProcesses = Schema.decodeUnknownSync(ProcessIdentities)(
          runReferenceFixture({
            cwd: outside,
            asRoot: true,
            code: `
              const identities = await Effect.runPromise(Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem
                const scan = yield* readProcessReferences({ fs, selfPid: process.pid })
                if (scan._tag !== 'complete') return yield* Effect.die(encodeJson(scan))
                return scan.processIdentities
              }).pipe(Effect.provide(NodeServices.layer)))
              console.log(encodeJson(identities))
            `,
          }),
        )
        // Capture must include a process with no path under the candidate worktree.
        expect(coveredProcesses).toContainEqual(hidden.identity)
        const wrongStartTime = coveredProcesses.map((identity) =>
          identity.pid === hidden.identity.pid
            ? { ...identity, startTime: String(BigInt(identity.startTime) + 1n) }
            : identity,
        )
        const report = runReferenceFixture({
          cwd: outside,
          code: `
            const report = await Effect.runPromise(Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem
              const pid = ${hidden.identity.pid}
              const stat = parseProcStat(yield* fs.readFileString('/proc/' + pid + '/stat'))
              const uids = parseProcUids(yield* fs.readFileString('/proc/' + pid + '/status'))
              const denied = yield* Effect.forEach(['cwd', 'root', 'fd', 'maps'], (entry) =>
                (entry === 'cwd' || entry === 'root'
                  ? fs.readLink('/proc/' + pid + '/' + entry)
                  : entry === 'fd'
                    ? fs.readDirectory('/proc/' + pid + '/fd')
                    : fs.readFileString('/proc/' + pid + '/maps')
                ).pipe(Effect.option, Effect.map((result) => result._tag === 'None')))
              const scan = (coveredProcesses) => readProcessReferences({
                fs, selfPid: process.pid, scope: 'own-uid', coveredProcesses,
              })
              const exact = yield* scan(${encodeJson(coveredProcesses)})
              return {
                identity: { pid, startTime: stat?.startTime },
                ownUid: uids?.every((uid) => uid === process.getuid()),
                denied,
                uncovered: yield* scan(undefined),
                wrongStartTime: yield* scan(${encodeJson(wrongStartTime)}),
                exact: exact._tag,
                identities: exact._tag === 'complete' ? exact.processIdentities : [],
                candidate: yield* readWorktreeReferencesInUse({
                  worktreePath: ${encodeJson(worktree)}, scope: 'own-uid',
                  coveredProcesses: ${encodeJson(coveredProcesses)},
                }),
                strictForeign: yield* readWorktreeReferencesInUse({
                  worktreePath: ${encodeJson(worktree)},
                  coveredProcesses: ${encodeJson(coveredProcesses)},
                }),
              }
            }).pipe(Effect.provide(NodeServices.layer)))
            console.log(encodeJson(report))
          `,
        })
        expect(report).toMatchObject({
          identity: hidden.identity,
          ownUid: true,
          denied: [true, true, true, true],
          uncovered: { _tag: 'unknown', reason: 'inaccessible-process', pid: hidden.identity.pid },
          wrongStartTime: {
            _tag: 'unknown',
            reason: 'inaccessible-process',
            pid: hidden.identity.pid,
          },
          exact: 'complete',
          identities: expect.arrayContaining([hidden.identity]),
          candidate: { _tag: 'free' },
          // Identity proof never permits all-UID scans to skip foreign owners.
          strictForeign: { _tag: 'unknown', reason: 'inaccessible-process' },
        })

        const readable = yield* Effect.acquireRelease(
          Effect.promise(() => spawnIdentityHolder({ cwd: worktree, nonDumpable: false })),
          ({ child }) => Effect.promise(() => stopIdentityHolder(child)),
        )
        expect(coveredProcesses).not.toContainEqual(readable.identity)
        expect(
          runReferenceFixture({
            cwd: outside,
            code: `
              const result = await Effect.runPromise(readWorktreeReferencesInUse({
                worktreePath: ${encodeJson(worktree)}, scope: 'own-uid',
                coveredProcesses: ${encodeJson(coveredProcesses)},
              }).pipe(Effect.provide(NodeServices.layer)))
              console.log(encodeJson(result))
            `,
          }),
        ).toMatchObject({ _tag: 'in-use', holder: { pid: readable.identity.pid, path: worktree } })
        yield* Effect.promise(() => stopIdentityHolder(readable.child))

        // This process did not exist at capture; a still-fresh identity list cannot waive it.
        const late = yield* Effect.acquireRelease(
          Effect.promise(() => spawnIdentityHolder({ cwd: outside })),
          ({ child }) => Effect.promise(() => stopIdentityHolder(child)),
        )
        expect(coveredProcesses).not.toContainEqual(late.identity)
        expect(
          runReferenceFixture({
            cwd: outside,
            code: `
              const result = await Effect.runPromise(Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem
                return yield* readProcessReferences({
                  fs, selfPid: process.pid, scope: 'own-uid',
                  coveredProcesses: ${encodeJson(coveredProcesses)},
                })
              }).pipe(Effect.provide(NodeServices.layer)))
              console.log(encodeJson(result))
            `,
          }),
        ).toMatchObject({ _tag: 'unknown', reason: 'inaccessible-process', pid: late.identity.pid })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 120_000 },
  )

  it.effect.skipIf(runsAsRoot === false)(
    'sees cwd and open-file holders, excludes descendants, and frees after exit',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
        const worktree = `${root}/worktree`
        const outside = `${root}/outside`
        yield* fs.makeDirectory(`${worktree}/target`, { recursive: true })
        yield* fs.makeDirectory(outside)
        yield* fs.writeFileString(`${worktree}/target/artifact`, 'bytes')

        const standIn = yield* Effect.promise(() => spawnHolder(outside))
        const cwdHolder = yield* Effect.promise(() => spawnHolder(worktree))
        const cwdResult = yield* readWorktreeReferencesInUse({
          worktreePath: worktree,
          selfPid: standIn.pid!,
        })
        expect(cwdResult).toMatchObject({ _tag: 'in-use', holder: { pid: cwdHolder.pid } })
        yield* Effect.promise(() => killHolder(cwdHolder))

        const fdHolder = yield* Effect.promise(() =>
          spawnFdHolder({ cwd: outside, file: `${worktree}/target/artifact` }),
        )
        const fdResult = yield* readWorktreeReferencesInUse({
          worktreePath: worktree,
          selfPid: standIn.pid!,
        })
        expect(fdResult).toMatchObject({
          _tag: 'in-use',
          holder: { pid: fdHolder.pid, path: `${worktree}/target/artifact` },
        })
        // The same holder is this test's descendant: never a self-veto.
        expect(yield* readWorktreeReferencesInUse({ worktreePath: worktree })).toEqual({
          _tag: 'free',
        })
        const descendantScan = yield* readProcessReferences({ fs, selfPid: process.pid })
        expect(descendantScan._tag).toBe('complete')
        if (descendantScan._tag === 'complete') {
          const stat = parseProcStat(yield* fs.readFileString(`/proc/${fdHolder.pid!}/stat`))
          expect(descendantScan.processIdentities).toContainEqual({
            pid: fdHolder.pid,
            startTime: stat?.startTime,
          })
          expect(
            descendantScan.references.some((reference) => reference.pid === fdHolder.pid),
          ).toBe(false)
        }
        yield* Effect.promise(() => killHolder(fdHolder))
        yield* Effect.promise(() => killHolder(standIn))

        expect(yield* readWorktreeReferencesInUse({ worktreePath: worktree, selfPid: 1 })).toEqual({
          _tag: 'free',
        })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
