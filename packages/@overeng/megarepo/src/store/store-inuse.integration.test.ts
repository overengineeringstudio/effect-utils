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
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { systemError } from 'effect/PlatformError'
import * as ChildProcessCommand from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
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
  const child = spawn('sh', ['-c', 'exec 3<"$1"; printf ready; exec sleep 120', 'holder', file], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  child.stdout!.once('data', () => resolve(child))
  child.once('error', reject)
  child.once('exit', (code) => reject(new Error(`fd holder exited before readiness: ${code}`)))
  return promise
}

/** All privileged commands below operate only on holders or their scoped fixture. */
const referenceModule = fileURLToPath(new URL('./store-inuse.ts', import.meta.url))
const jsonModule = fileURLToPath(new URL('../test-utils/json.ts', import.meta.url))
const ProcessIdentities = Schema.Array(
  Schema.Struct({ pid: Schema.Finite, startTime: Schema.String }),
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
  // Root process coverage can exceed Linux's per-argument limit on a busy host.
  // Keep the real fixture program in the scoped filesystem, not a giant --eval argument.
  const scriptPath = `${cwd}/../reference-fixture-${randomUUID()}.mjs`
  writeFileSync(
    scriptPath,
    `
      import { NodeServices, Effect, FileSystem, parseProcStat, parseProcUids, readProcessReferences, readWorktreeReferencesInUse, encodeJson } from ${encodeJson(`${cwd}/../reference-runtime.mjs`)}
      ${code}
    `,
    { mode: 0o644 },
  )
  try {
    const result = spawnSync(
      'sudo',
      [
        '-n',
        ...(asRoot === true ? [] : ['-u', 'nobody']),
        '/usr/bin/env',
        `PATH=${process.env['PATH'] ?? ''}`,
        'bun',
        scriptPath,
      ],
      { cwd, encoding: 'utf8', timeout: 120_000 },
    )
    expect(
      result.status,
      `sudo fixture failed: ${result.error?.message ?? ''}; signal=${result.signal}; ${result.stderr}`,
    ).toBe(0)
    return decodeJson(result.stdout.trim())
  } finally {
    unlinkSync(scriptPath)
  }
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
  for (const scenario of [
    {
      name: 'ignores and counts an unreadable foreign process',
      foreign: true,
      cwd: '/outside',
      readableCwd: false,
      tag: 'free',
    },
    {
      name: 'vetoes a readable foreign cwd despite denied remaining fields',
      foreign: true,
      cwd: '/worktree/subdir',
      readableCwd: true,
      tag: 'in-use',
    },
    {
      name: 'keeps an own-UID process when lsof fails',
      foreign: false,
      cwd: '/outside',
      readableCwd: false,
      tag: 'unknown',
    },
    {
      name: 'retains readable own cwd evidence even when lsof fails',
      foreign: false,
      cwd: '/worktree',
      readableCwd: true,
      tag: 'in-use',
    },
  ] as const) {
    it.effect(
      `gc-owner ${scenario.name}`,
      Effect.fnUntraced(function* () {
        const base = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner
        const ownUid = process.getuid!()
        const uid = scenario.foreign === true ? ownUid + 1 : ownUid
        let lsofPasses = 0
        const denied = (path: string) =>
          Effect.fail(
            systemError({
              _tag: 'PermissionDenied',
              module: 'FileSystem',
              method: 'gc-owner-fixture',
              pathOrDescriptor: path,
            }),
          )
        const fs: FileSystem.FileSystem = {
          ...base,
          realPath: (path) => Effect.succeed(path),
          readDirectory: (path) =>
            path === '/proc'
              ? Effect.succeed(scenario.foreign === true ? ['42'] : ['42', '43'])
              : denied(path),
          readFileString: (path) =>
            path.endsWith('/stat') === true
              ? Effect.succeed(`42 (holder) S 1 42 42 0 -1 0 ${'0 '.repeat(12)}1234`)
              : path.endsWith('/status') === true
                ? Effect.succeed(`Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`)
                : denied(path),
          readLink: (path) =>
            scenario.readableCwd === true && path.endsWith('/cwd') === true
              ? Effect.succeed(scenario.cwd)
              : denied(path),
        }
        const result = yield* readWorktreeReferencesInUse({
          worktreePath: '/worktree',
          selfPid: 99,
          scope: 'gc-owner',
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(ChildProcessSpawner, {
            ...spawner,
            spawn: () => {
              lsofPasses += 1
              return denied('lsof')
            },
          }),
        )
        expect(result).toMatchObject({
          _tag: scenario.tag,
          ignoredForeignProcesses: scenario.foreign === true ? 1 : 0,
        })
        // All incomplete own-UID PIDs share one five-second lsof budget/pass.
        expect(lsofPasses).toBe(scenario.foreign === true ? 0 : 1)
        if (result._tag === 'in-use') {
          expect(result.holder).toEqual({ pid: 42, path: scenario.cwd })
        }
        if (result._tag === 'unknown') expect(result.reason).toBe('own-uid-unreadable')
        // The original scope must remain fail-closed for this exact same fixture.
        expect(
          yield* readWorktreeReferencesInUse({
            worktreePath: '/worktree',
            selfPid: 99,
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
        ).toEqual({
          _tag: 'unknown',
          reason: 'inaccessible-process',
        })
      }, Effect.provide(NodeServices.layer)),
    )
  }

  for (const scenario of [
    { name: 'exempts only the unreadable user manager', tag: 'free' },
    { name: 'still vetoes another unreadable own-UID process', otherOwner: true, tag: 'unknown' },
    { name: 'retains an exempt manager readable cwd', readable: 'cwd', tag: 'in-use' },
    { name: 'retains an exempt manager readable root', readable: 'root', tag: 'in-use' },
    { name: 'retains an exempt manager readable descriptor', readable: 'fd', tag: 'in-use' },
    { name: 'retains an exempt manager readable mapping', readable: 'map', tag: 'in-use' },
    { name: 'exempts the user-manager PAM child', pamChild: true, tag: 'free' },
    {
      name: 'rejects a forged manager absent from system unit state',
      managerPid: 77,
      tag: 'unknown',
    },
    { name: 'rejects unavailable system unit state', managerUnavailable: true, tag: 'unknown' },
    { name: 'rejects PAM without a verified manager parent', comm: '(sd-pam)', tag: 'unknown' },
    {
      name: 'rejects PAM with a non-user-manager parent',
      pamChild: true,
      cmdline: 'systemd\0--system\0',
      tag: 'unknown',
    },
    { name: 'exempts an SSH privilege transition', comm: 'sshd-session', parent: 200, tag: 'free' },
    { name: 'exempts a legacy SSH privilege transition', comm: 'sshd', parent: 200, tag: 'free' },
    {
      name: 'rejects a spoofed SSH comm with an own-UID parent',
      comm: 'sshd-session',
      parent: 200,
      sshParentOwnUid: true,
      tag: 'unknown',
    },
    {
      name: 'rejects SSH with unreadable parent evidence',
      comm: 'sshd-session',
      parent: 200,
      sshParentDenied: true,
      tag: 'unknown',
    },
    {
      name: 'rejects SSH with a non-SSH root parent',
      comm: 'sshd-session',
      parent: 200,
      sshParentComm: 'other',
      tag: 'unknown',
    },
    {
      name: 'retains an SSH transition readable cwd',
      comm: 'sshd-session',
      readable: 'cwd',
      parent: 200,
      tag: 'in-use',
    },
    { name: 'retains a PAM child readable cwd', pamChild: true, pamHolder: true, tag: 'in-use' },
    { name: 'rejects an unlisted SSH-like process', comm: 'sshd-helper', tag: 'unknown' },
    {
      name: 'rejects mixed-UID SSH processes',
      comm: 'sshd-session',
      mixedUids: true,
      tag: 'unknown',
    },
    { name: 'counts but does not exempt a foreign manager', foreignUids: true, tag: 'free' },
    {
      name: 'counts but does not exempt a foreign SSH transition',
      comm: 'sshd-session',
      foreignUids: true,
      tag: 'free',
    },
    { name: 'rejects a different comm', comm: 'systemd-helper', tag: 'unknown' },
    { name: 'rejects a different parent', parent: 2, tag: 'unknown' },
    {
      name: 'rejects a different second argument',
      cmdline: '/usr/lib/systemd/systemd\0--system\0--user\0',
      tag: 'unknown',
    },
    { name: 'rejects an unreadable command line', deniedCmdline: true, tag: 'unknown' },
    { name: 'rejects mixed UIDs', mixedUids: true, tag: 'unknown' },
    { name: 'rejects missing UID evidence', missingUids: true, tag: 'unknown' },
    { name: 'rejects a recycled manager PID', changedLifetime: true, tag: 'unknown' },
    { name: 'rejects a changed comm', changedComm: true, tag: 'unknown' },
    { name: 'rejects a changed parent', changedParent: true, tag: 'unknown' },
  ] as const) {
    it.effect.skipIf('sshParentOwnUid' in scenario && runsAsRoot === true)(
      `gc-owner systemd policy ${scenario.name}`,
      Effect.fnUntraced(function* () {
        const base = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner
        const ownUid = process.getuid!()
        const option: {
          otherOwner?: boolean
          pamChild?: boolean
          pamHolder?: boolean
          foreignUids?: boolean
          readable?: string
          comm?: string
          parent?: number
          cmdline?: string
          deniedCmdline?: boolean
          mixedUids?: boolean
          missingUids?: boolean
          changedLifetime?: boolean
          changedComm?: boolean
          changedParent?: boolean
          sshParentOwnUid?: boolean
          sshParentDenied?: boolean
          sshParentComm?: string
          managerPid?: number
          managerUnavailable?: boolean
        } = scenario
        let statReads = 0
        let lsofPasses = 0
        const denied = (path: string) =>
          Effect.fail(
            systemError({
              _tag: 'PermissionDenied',
              module: 'FileSystem',
              method: 'systemd-fixture',
              pathOrDescriptor: path,
            }),
          )
        const fs: FileSystem.FileSystem = {
          ...base,
          exists: () => Effect.succeed(true),
          realPath: (path) => Effect.succeed(path),
          readDirectory: (path) =>
            path === '/proc'
              ? Effect.succeed(
                  option.otherOwner === true
                    ? ['42', '43']
                    : option.pamChild === true
                      ? ['42', '44']
                      : ['42'],
                )
              : path === '/proc/42/fd' && option.readable === 'fd'
                ? Effect.succeed(['7'])
                : denied(path),
          readFileString: (path) => {
            if (path.startsWith('/proc/200/') === true) {
              if (option.sshParentDenied === true) return denied(path)
              if (path.endsWith('/stat') === true) {
                return Effect.succeed(
                  `200 (${option.sshParentComm ?? 'sshd-session'}) S 1 200 200 0 -1 0 ${'0 '.repeat(12)}1000`,
                )
              }
              if (path.endsWith('/status') === true) {
                const uid = option.sshParentOwnUid === true ? ownUid : 0
                return Effect.succeed(`Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`)
              }
              return denied(path)
            }
            const manager = path.startsWith('/proc/42/')
            if (path.endsWith('/stat') === true) {
              const after = manager && ++statReads > 1
              const comm =
                manager === true
                  ? after === true && option.changedComm === true
                    ? 'other'
                    : (option.comm ?? 'systemd')
                  : path.startsWith('/proc/44/') === true
                    ? '(sd-pam)'
                    : 'holder'
              const parent =
                manager === true
                  ? after === true && option.changedParent === true
                    ? 2
                    : (option.parent ?? 1)
                  : path.startsWith('/proc/44/') === true
                    ? 42
                    : 1
              const startTime = after === true && option.changedLifetime === true ? '5678' : '1234'
              return Effect.succeed(
                `42 (${comm}) S ${parent} 42 42 0 -1 0 ${'0 '.repeat(12)}${startTime}`,
              )
            }
            if (path.endsWith('/status') === true) {
              const uid = option.foreignUids === true ? ownUid + 1 : ownUid
              return Effect.succeed(
                option.missingUids === true
                  ? 'Name:\tsystemd\n'
                  : `Uid:\t${uid}\t${option.mixedUids === true ? uid + 1 : uid}\t${uid}\t${uid}\nCapEff:\t0000000800000000\n`,
              )
            }
            if (path.endsWith('/cmdline') === true && option.deniedCmdline !== true) {
              return Effect.succeed(option.cmdline ?? '/usr/lib/systemd/systemd\0--user\0')
            }
            if (manager === true && path.endsWith('/maps') === true && option.readable === 'map') {
              return Effect.succeed('7f01-7f02 r--p 00000000 08:02 99 /worktree/held')
            }
            return denied(path)
          },
          readLink: (path) =>
            (path === '/proc/44/cwd' && option.pamHolder === true) ||
            path === `/proc/42/${option.readable}` ||
            (path === '/proc/42/fd/7' && option.readable === 'fd')
              ? Effect.succeed('/worktree/held')
              : denied(path),
        }
        const result = yield* readWorktreeReferencesInUse({
          worktreePath: '/worktree',
          selfPid: 99,
          scope: 'gc-owner',
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(ChildProcessSpawner, {
            ...spawner,
            spawn: (command) => {
              if (
                command._tag === 'StandardCommand' &&
                command.command.endsWith('/systemctl') === true
              ) {
                return option.managerUnavailable === true
                  ? denied('systemctl')
                  : spawner.spawn(
                      ChildProcessCommand.make('printf', [`${option.managerPid ?? 42}`]),
                    )
              }
              lsofPasses += 1
              return denied('lsof')
            },
          }),
        )
        const exempt =
          option.foreignUids !== true && (scenario.tag !== 'unknown' || option.otherOwner === true)
        expect(result).toMatchObject({
          _tag: scenario.tag,
          ignoredForeignProcesses: option.foreignUids === true ? 1 : 0,
          exemptProcesses:
            exempt === true
              ? [
                  {
                    pid: 42,
                    startTime: '1234',
                    comm: option.comm ?? 'systemd',
                    rule:
                      option.comm === 'sshd-session' || option.comm === 'sshd'
                        ? 'sshd-privilege-transition'
                        : 'systemd-user-manager',
                  },
                  ...(option.pamChild === true
                    ? [{ pid: 44, startTime: '1234', comm: '(sd-pam)', rule: 'systemd-user-pam' }]
                    : []),
                ]
              : [],
        })
        expect(lsofPasses).toBe(
          scenario.tag === 'unknown' && option.changedLifetime !== true ? 1 : 0,
        )
        if (result._tag === 'unknown') expect(result.reason).toBe('own-uid-unreadable')
        if (result._tag === 'in-use') {
          expect(result.holder).toEqual({
            pid: option.pamHolder === true ? 44 : 42,
            path: '/worktree/held',
          })
        }
        // Neither strict scope is authorized to waive this native unreadability.
        for (const scope of exempt === true ? (['all-uids', 'own-uid'] as const) : []) {
          statReads = 0
          expect(
            yield* readWorktreeReferencesInUse({
              worktreePath: '/worktree',
              selfPid: 99,
              scope,
            }).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
          ).toMatchObject({
            _tag: 'unknown',
            reason: 'inaccessible-process',
          })
        }
      }, Effect.provide(NodeServices.layer)),
    )
  }

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

  if (process.env['MEGAREPO_TEST_PRIVILEGED'] === '1') {
    it.live(
      'privileged: only exact root-scanned identities cover unreadable own-UID processes; new readable references are still scanned',
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
          // The isolated UID must not depend on access to private checkout ancestors.
          // Bundle the real runtime and its dependencies into this readable fixture.
          const entry = `${root}/reference-runtime.ts`
          const runtime = `${root}/reference-runtime.mjs`
          yield* fs.writeFileString(
            entry,
            `
            export { NodeServices } from ${encodeJson(fileURLToPath(import.meta.resolve('@effect/platform-node')))}
            export { Effect } from ${encodeJson(fileURLToPath(import.meta.resolve('effect')))}
            export * as FileSystem from ${encodeJson(fileURLToPath(import.meta.resolve('effect/FileSystem')))}
            export { parseProcStat, parseProcUids, readProcessReferences, readWorktreeReferencesInUse } from ${encodeJson(referenceModule)}
            export { encodeJson } from ${encodeJson(jsonModule)}
          `,
          )
          const bundled = spawnSync('bun', ['build', entry, '--target=bun', '--outfile', runtime], {
            encoding: 'utf8',
            timeout: 120_000,
          })
          expect(bundled.status, `reference fixture bundle failed: ${bundled.stderr}`).toBe(0)
          yield* fs.chmod(runtime, 0o644)
          const hidden = yield* Effect.acquireRelease(
            Effect.promise(() => spawnIdentityHolder({ cwd: outside })),
            ({ child }) => Effect.promise(() => stopIdentityHolder(child)),
          )
          const coveredProcesses = yield* Schema.decodeUnknownEffect(ProcessIdentities)(
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
            uncovered: {
              _tag: 'unknown',
              reason: 'inaccessible-process',
              pid: hidden.identity.pid,
            },
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
          ).toMatchObject({
            _tag: 'in-use',
            holder: { pid: readable.identity.pid, path: worktree },
          })
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
          ).toMatchObject({
            _tag: 'unknown',
            reason: 'inaccessible-process',
            pid: late.identity.pid,
          })
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
      { timeout: 120_000 },
    )
  }

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
