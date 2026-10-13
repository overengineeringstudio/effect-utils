/** Root-scoped Buck2 shutdown before GC renames or removes a worktree. */
import { Effect, Option, Schema, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Command from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import {
  isInsideWorktree,
  parseProcStat,
  parseProcUids,
  type ProcessIdentity,
} from './store-inuse.ts'

const daemonFields = {
  pid: Schema.Int,
  daemonId: Schema.String,
  isolation: Schema.String,
  root: Schema.String,
  path: Schema.String,
}

/** Memory is the pre-kill RSS + VmSwap of the daemon and its own forkserver. */
export const BuckDaemonStopped = Schema.TaggedStruct('stopped', {
  ...daemonFields,
  freedKiB: Schema.Int,
})
export type BuckDaemonStopped = typeof BuckDaemonStopped.Type

/** A daemon that could not be stopped safely; `reason` says why (archived root, deleted cwd, status). */
export const BuckDaemonUnreachable = Schema.TaggedStruct('unreachable', {
  ...daemonFields,
  memoryKiB: Schema.Int,
  reason: Schema.String,
})
export type BuckDaemonUnreachable = typeof BuckDaemonUnreachable.Type

/** Per-daemon outcome of a teardown shutdown attempt. */
export type BuckDaemonResult =
  | BuckDaemonStopped
  | BuckDaemonUnreachable
  | ({ readonly _tag: 'kept-active' } & BuckDaemonIdentity)

/** Identity of a daemon as seen in `/proc` (argv daemon id + isolation, cwd-derived root). */
export interface BuckDaemonIdentity {
  readonly pid: number
  readonly daemonId: string
  readonly isolation: string
  readonly root: string
  readonly path: string
}

/** A recognized daemon process plus whether its cwd was unlinked. */
export interface BuckDaemonProcess extends BuckDaemonIdentity {
  readonly cwdDeleted: boolean
}

/** Buck daemons can sit at the project root or <root>/buck-out/<isolation>. */
export const recognizeBuckDaemon = ({
  pid,
  argv,
  cwd,
}: {
  pid: number
  argv: ReadonlyArray<string>
  cwd: string
}): BuckDaemonProcess | undefined => {
  const isolationIndex = argv.indexOf('--isolation-dir')
  const daemonIdIndex = argv.indexOf('--daemon-id')
  const isolation = isolationIndex < 0 ? undefined : argv[isolationIndex + 1]
  const daemonId = daemonIdIndex < 0 ? undefined : argv[daemonIdIndex + 1]
  if (
    argv.includes('daemon') === false ||
    isolation === undefined ||
    isolation.length === 0 ||
    isolation.startsWith('-') === true ||
    daemonId === undefined ||
    daemonId.length === 0 ||
    daemonId.startsWith('-') === true
  )
    return undefined
  const cwdDeleted = cwd.endsWith(' (deleted)')
  const path = cwdDeleted === true ? cwd.slice(0, -' (deleted)'.length) : cwd
  const suffix = `/buck-out/${isolation}`
  if (path.startsWith('/') === false) return undefined
  const root = path.endsWith(suffix) === true ? path.slice(0, -suffix.length) : path
  if (root.length === 0) return undefined
  return { pid, daemonId, isolation, root, path, cwdDeleted }
}

/** The subset of pinned `buck2 status` output used to confirm identity and idleness. */
export const BuckDaemonStatus = Schema.Struct({
  process_info: Schema.Struct({ pid: Schema.Int }),
  daemon_constraints: Schema.Struct({ daemon_id: Schema.String }),
  active_commands: Schema.Array(Schema.Unknown),
})

/** Status must prove both the observed identity and an empty active-command list. */
export const decideBuckDaemon = ({
  daemon,
  status,
}: {
  daemon: BuckDaemonIdentity
  status: typeof BuckDaemonStatus.Type
}): 'stop' | 'kept-active' | 'identity-mismatch' => {
  if (
    status.process_info.pid !== daemon.pid ||
    status.daemon_constraints.daemon_id !== daemon.daemonId
  )
    return 'identity-mismatch'
  return status.active_commands.length === 0 ? 'stop' : 'kept-active'
}

/** Linux reports both resident and swapped memory in KiB (despite the kB label). */
export const buckProcessMemoryKiB = (status: string): number => {
  let memoryKiB = 0
  for (const match of status.matchAll(/^(?:VmRSS|VmSwap):\s+(\d+) kB$/gmu)) {
    memoryKiB += Number(match[1])
  }
  return memoryKiB
}

interface BuckProcess {
  readonly pid: number
  readonly parentPid: number
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly memoryKiB: number
  readonly identity: ProcessIdentity
}

const readBuckProcesses = Effect.fn('store.readBuckProcesses')(function* () {
  const fs = yield* FileSystem.FileSystem
  const uid = process.getuid?.()
  if (process.platform !== 'linux' || uid === undefined) return []
  const listing = yield* fs.readDirectory('/proc').pipe(Effect.orElseSucceed(() => []))
  return yield* Effect.forEach(
    listing.filter((name) => /^\d+$/u.test(name)),
    (name) =>
      Effect.gen(function* () {
        const status = yield* fs.readFileString(`/proc/${name}/status`)
        const uids = parseProcUids(status)
        if (uids === undefined || uids.some((value) => value !== uid) === true) return []
        const executable = yield* fs.readLink(`/proc/${name}/exe`)
        if (executable.endsWith('/buck2') === false) return []
        const before = parseProcStat(yield* fs.readFileString(`/proc/${name}/stat`))
        if (before === undefined) return []
        const argv = (yield* fs.readFileString(`/proc/${name}/cmdline`))
          .split('\0')
          .filter((arg) => arg !== '')
        const cwd = yield* fs.readLink(`/proc/${name}/cwd`)
        const after = parseProcStat(yield* fs.readFileString(`/proc/${name}/stat`))
        if (after === undefined || after.startTime !== before.startTime) return []
        return [
          {
            pid: Number(name),
            parentPid: after.parentPid,
            argv,
            cwd,
            memoryKiB: buckProcessMemoryKiB(status),
            identity: { pid: Number(name), startTime: after.startTime },
          },
        ]
      }).pipe(Effect.orElseSucceed(() => [])),
    { concurrency: 16 },
  ).pipe(Effect.map((entries): ReadonlyArray<BuckProcess> => entries.flat()))
})

/** A daemon inside a worktree with its own process identities and pre-kill memory. */
export interface WorktreeBuckDaemon {
  readonly daemon: BuckDaemonProcess
  readonly processes: ReadonlyArray<ProcessIdentity>
  readonly memoryKiB: number
}

/** Lifetime-bound discovery also lets teardown admit all non-Buck activity first. */
export const findWorktreeBuckDaemons = Effect.fn('store.findWorktreeBuckDaemons')(function* ({
  worktreePath,
}: {
  worktreePath: string
}) {
  if (process.env['MEGAREPO_GC_BUCK2_BIN'] === '') return []
  const fs = yield* FileSystem.FileSystem
  const canonical = yield* fs.realPath(worktreePath).pipe(Effect.orElseSucceed(() => worktreePath))
  const processes = yield* readBuckProcesses()
  const daemons: WorktreeBuckDaemon[] = []
  for (const entry of processes) {
    const daemon = recognizeBuckDaemon({ pid: entry.pid, argv: entry.argv, cwd: entry.cwd })
    if (
      daemon === undefined ||
      isInsideWorktree({ candidate: daemon.path, worktreePath: canonical }) === false
    )
      continue
    const forkserver = processes.find(
      (child) => child.parentPid === daemon.pid && child.argv[1] === 'forkserver',
    )
    daemons.push({
      daemon,
      processes:
        forkserver === undefined ? [entry.identity] : [entry.identity, forkserver.identity],
      memoryKiB: entry.memoryKiB + (forkserver?.memoryKiB ?? 0),
    })
  }
  return daemons
})

/**
 * Never throws into GC. Archived roots are report-only: Buck's daemon address is
 * keyed to the original root, so status/kill from the renamed root is unsafe.
 * An empty binary override disables discovery as well as shutdown.
 */
export const stopWorktreeBuckDaemons = Effect.fn('store.stopWorktreeBuckDaemons')(function* ({
  worktreePath,
  archived = false,
}: {
  worktreePath: string
  archived?: boolean
}) {
  const binary = process.env['MEGAREPO_GC_BUCK2_BIN'] ?? 'buck2'
  if (binary === '') return []
  const daemons = yield* findWorktreeBuckDaemons({ worktreePath })
  const results: BuckDaemonResult[] = []
  for (const { daemon, memoryKiB } of daemons) {
    const { cwdDeleted, ...identity } = daemon
    if (archived === true || cwdDeleted === true) {
      results.push({
        _tag: 'unreachable',
        ...identity,
        memoryKiB,
        reason: archived === true ? 'archived-root' : 'deleted-cwd',
      })
      continue
    }
    const status = yield* ChildProcessSpawner.use((spawner) =>
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          Command.make(binary, ['--isolation-dir', daemon.isolation, 'status'], {
            cwd: daemon.root,
          }),
        )
        const [stdout, exitCode] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
          { concurrency: 2 },
        )
        if (exitCode !== 0) return yield* Effect.fail({ _tag: 'StatusExitFailed', exitCode })
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BuckDaemonStatus))(stdout)
      }).pipe(Effect.scoped),
    ).pipe(Effect.timeout('30 seconds'), Effect.option)
    if (Option.isNone(status) === true) {
      results.push({ _tag: 'unreachable', ...identity, memoryKiB, reason: 'status-unreadable' })
      continue
    }
    const decision = decideBuckDaemon({ daemon, status: status.value })
    if (decision === 'kept-active') {
      results.push({ _tag: 'kept-active', ...identity })
      continue
    }
    if (decision === 'identity-mismatch') {
      results.push({
        _tag: 'unreachable',
        ...identity,
        memoryKiB,
        reason: 'status-identity-mismatch',
      })
      continue
    }
    const killed = yield* ChildProcessSpawner.use((spawner) =>
      spawner.exitCode(
        Command.make(binary, ['--isolation-dir', daemon.isolation, 'kill'], { cwd: daemon.root }),
      ),
    ).pipe(Effect.timeout('30 seconds'), Effect.option)
    results.push(
      Option.isSome(killed) === true && killed.value === 0
        ? { _tag: 'stopped', ...identity, freedKiB: memoryKiB }
        : { _tag: 'unreachable', ...identity, memoryKiB, reason: 'kill-failed' },
    )
  }
  return results
})
