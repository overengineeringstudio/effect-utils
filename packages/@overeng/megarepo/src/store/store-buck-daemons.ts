/** Root-scoped Buck2 shutdown before GC renames or removes a worktree. */
import { dirname } from 'node:path'

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

/**
 * Memory is the pre-kill RSS + VmSwap of the daemon and its own forkserver.
 * `raced` is set when the kill met work it was not meant for: another daemon
 * pid exited, or a command wrote an event log between the final read and the kill.
 */
export const BuckDaemonStopped = Schema.TaggedStruct('stopped', {
  ...daemonFields,
  freedKiB: Schema.Int,
  raced: Schema.optional(Schema.String),
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
  const cwdDeleted = cwd.endsWith(' (deleted)') === true
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

/** Filesystem observations in cwd-to-root order, as used by pinned Buck's get_roots. */
export interface BuckRootAncestor {
  readonly path: string
  readonly buckconfig: boolean
  readonly buckroot: boolean
}

/**
 * Buck selects the outermost .buckconfig before .buckroot, excluding HOME's
 * configuration override. A .buckroot alone does not establish a project.
 */
export const buckClientProjectRoot = ({
  ancestors,
  homeDirectory,
}: {
  ancestors: ReadonlyArray<BuckRootAncestor>
  homeDirectory: string | undefined
}): string | undefined => {
  let root: string | undefined
  for (const ancestor of ancestors) {
    if (ancestor.buckconfig === true) {
      if (ancestor.path === homeDirectory) break
      root = ancestor.path
    }
    if (ancestor.buckroot === true) break
  }
  return root
}

/** Unknown client identity holds teardown; known identity requires root AND isolation. */
export const buckClientHoldsWorktree = ({
  cwd,
  root,
  isolation,
  worktree,
  daemons,
}: {
  cwd: string
  root: string | undefined
  isolation: string | undefined
  worktree: string
  daemons: ReadonlyArray<BuckDaemonIdentity>
}): boolean =>
  isInsideWorktree({ candidate: cwd, worktreePath: worktree }) === true ||
  root === undefined ||
  isolation === undefined ||
  daemons.some((daemon) => daemon.root === root && daemon.isolation === isolation) === true

/** Resolve pinned Buck's project root without starting a daemon; unreadable markers fail. */
export const readBuckProjectRoot = Effect.fn('store.readBuckProjectRoot')(function* ({
  cwd,
  homeDirectory,
}: {
  cwd: string
  homeDirectory: string | undefined
}) {
  const fs = yield* FileSystem.FileSystem
  if (cwd.startsWith('/') === false || cwd.endsWith(' (deleted)') === true) return undefined
  const ancestors: BuckRootAncestor[] = []
  let directory = cwd
  while (true) {
    // exists() can hide permission errors. Only NotFound proves an absent marker.
    const markers = yield* Effect.forEach(['.buckconfig', '.buckroot'], (name) =>
      fs.stat(`${directory}/${name}`).pipe(
        Effect.map(() => true),
        Effect.catchIf(
          (error) => error.reason._tag === 'NotFound',
          () => Effect.succeed(false),
        ),
      ),
    )
    const buckconfig = markers[0] === true
    const buckroot = markers[1] === true
    ancestors.push({ path: directory, buckconfig, buckroot })
    if (buckroot === true || (buckconfig === true && directory === homeDirectory)) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return buckClientProjectRoot({ ancestors, homeDirectory })
})
/** Any non-daemon Buck client targeting this root/isolation holds the daemon, including before RPC context registration. */
export const hasWorktreeBuckClients = Effect.fn('store.hasWorktreeBuckClients')(function* (
  worktree: string,
  daemons: ReadonlyArray<WorktreeBuckDaemon>,
) {
  const fs = yield* FileSystem.FileSystem
  const listing = yield* fs.readDirectory('/proc').pipe(Effect.option)
  if (Option.isNone(listing) === true) return true
  for (const name of listing.value) {
    if (/^[0-9]+$/u.test(name) === false || Number(name) === process.pid) continue
    const executable = yield* fs.readLink(`/proc/${name}/exe`).pipe(Effect.option)
    if (Option.isNone(executable) === true || executable.value.endsWith('/buck2') === false)
      continue
    const argv = yield* fs.readFileString(`/proc/${name}/cmdline`).pipe(Effect.option)
    const cwd = yield* fs.readLink(`/proc/${name}/cwd`).pipe(Effect.option)
    if (Option.isNone(argv) === true || Option.isNone(cwd) === true) return true
    const args = argv.value.split('\0').filter((arg) => arg !== '')
    if (
      (args.includes('daemon') === true && args.includes('--daemon-id') === true) ||
      args[1] === 'forkserver'
    )
      continue
    if (isInsideWorktree({ candidate: cwd.value, worktreePath: worktree }) === true) return true
    // Native Buck 2026-09-01 has no -C/--cwd override: cwd comes from current_dir().
    // Argfiles can hide identity flags, so they remain an uncertainty gate.
    const separator = args.indexOf('--')
    const options = separator < 0 ? args : args.slice(0, separator)
    if (options.some((arg) => arg.startsWith('@') === true || arg === '--flagfile') === true)
      return true
    const environment = yield* fs.readFileString(`/proc/${name}/environ`).pipe(Effect.option)
    if (Option.isNone(environment) === true) return true
    const variables = environment.value.split('\0')
    const homeDirectory = variables
      .find((variable) => variable.startsWith('HOME=') === true)
      ?.slice(5)
    // Without HOME we cannot reproduce Buck's user-config ascent boundary.
    if (homeDirectory === undefined || homeDirectory.startsWith('/') === false) return true
    const isolationIndex = options.indexOf('--isolation-dir')
    const isolation =
      isolationIndex < 0
        ? (options
            .find((argument) => argument.startsWith('--isolation-dir=') === true)
            ?.slice('--isolation-dir='.length) ??
          variables
            .find((variable) => variable.startsWith('BUCK_ISOLATION_DIR=') === true)
            ?.slice('BUCK_ISOLATION_DIR='.length) ??
          'v2')
        : options[isolationIndex + 1]
    const root = yield* readBuckProjectRoot({ cwd: cwd.value, homeDirectory }).pipe(
      Effect.orElseSucceed(() => undefined),
    )
    if (
      buckClientHoldsWorktree({
        cwd: cwd.value,
        root,
        isolation:
          isolation === undefined || isolation.length === 0 || isolation.startsWith('-') === true
            ? undefined
            : isolation,
        worktree,
        daemons: daemons.map((entry) => entry.daemon),
      }) === true
    )
      return true
  }
  return false
})

/** Newest event-log file write; `buck2 kill` itself only adds a directory there. */
export const newestBuckLogWriteMs = Effect.fn('store.newestBuckLogWriteMs')(function* (
  daemon: BuckDaemonIdentity,
) {
  const fs = yield* FileSystem.FileSystem
  const logDir = `${daemon.root}/buck-out/${daemon.isolation}/log`
  const entries = yield* fs.readDirectory(logDir).pipe(Effect.orElseSucceed(() => []))
  let newest: number | undefined
  for (const entry of entries) {
    // Buck rotates old logs concurrently; a vanished entry carries no activity.
    const info = yield* fs.stat(`${logDir}/${entry}`).pipe(Effect.option)
    if (Option.isNone(info) === true || info.value.type !== 'File') continue
    const mtimeMs = Option.getOrUndefined(info.value.mtime)?.getTime()
    if (mtimeMs !== undefined) newest = Math.max(newest ?? mtimeMs, mtimeMs)
  }
  return newest
})

/** Invoke the native binary against an existing daemon's exact root and isolation. */
export const runBuck2 = Effect.fn('store.runBuck2')(function* ({
  binary,
  daemon,
  subcommand,
}: {
  binary: string
  daemon: BuckDaemonIdentity
  subcommand: 'status' | 'kill'
}) {
  return yield* ChildProcessSpawner.use((spawner) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        Command.make(binary, ['--isolation-dir', daemon.isolation, subcommand], {
          cwd: daemon.root,
        }),
      )
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: 3 },
      )
      return { stdout, stderr, exitCode }
    }).pipe(Effect.scoped),
  ).pipe(Effect.timeout('30 seconds'), Effect.option)
})

/**
 * Never throws into GC. Archived roots are report-only: Buck's daemon address is
 * keyed to the original root, so status/kill from the renamed root is unsafe.
 * An empty binary override disables discovery as well as shutdown.
 *
 * `buck2 kill` has no conditional form. Memory is sampled at discovery, the
 * final status and event-log read is immediately followed by the kill, and
 * any race detected afterwards is logged and recorded as `raced`.
 */
export const stopWorktreeBuckDaemons = Effect.fn('store.stopWorktreeBuckDaemons')(function* ({
  worktreePath,
  archived = false,
  binary: requestedBinary,
  idleSinceMs,
  beforeKill,
  reportRaces = true,
  afterStop,
}: {
  worktreePath: string
  archived?: boolean
  /** Maintenance uses the observed native executable, never the admission launcher. */
  binary?: string
  /** Require event-log and daemon start time to precede this policy cutoff. */
  idleSinceMs?: number
  /** Final lease-protected holder/client check, immediately before the kill. */
  beforeKill?: () => Effect.Effect<boolean, never, FileSystem.FileSystem | ChildProcessSpawner>
  /** JSON receipt consumers record raced outcomes without contaminating stdout. */
  reportRaces?: boolean
  /** Observe a confirmed stop before considering the next isolation. */
  afterStop?: (daemon: BuckDaemonStopped) => Effect.Effect<void>
}) {
  const configuredBinary = requestedBinary ?? process.env['MEGAREPO_GC_BUCK2_BIN']
  if (configuredBinary === '') return []
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
    const fs = yield* FileSystem.FileSystem
    const binary =
      configuredBinary ??
      (yield* fs.readLink(`/proc/${daemon.pid}/exe`).pipe(Effect.orElseSucceed(() => undefined)))
    if (binary === undefined) {
      results.push({
        _tag: 'unreachable',
        ...identity,
        memoryKiB,
        reason: 'native-binary-unavailable',
      })
      continue
    }
    if ((yield* hasWorktreeBuckClients(worktreePath, daemons)) === true) {
      results.push({ _tag: 'kept-active', ...identity })
      continue
    }
    const decidedLogWriteMs = yield* newestBuckLogWriteMs(daemon)
    if (idleSinceMs !== undefined) {
      const daemonInfo = yield* fs.stat(`/proc/${daemon.pid}`).pipe(Effect.option)
      // Start time is read from status below; /proc existence is an additional lifetime check.
      if (Option.isNone(daemonInfo) === true || (decidedLogWriteMs ?? 0) > idleSinceMs) {
        results.push({ _tag: 'kept-active', ...identity })
        continue
      }
    }
    const statusRun = yield* runBuck2({ binary, daemon, subcommand: 'status' })
    const status =
      Option.isSome(statusRun) === true && statusRun.value.exitCode === 0
        ? yield* Schema.decodeEffect(Schema.fromJsonString(BuckDaemonStatus))(
            statusRun.value.stdout,
          ).pipe(Effect.option)
        : Option.none()
    if (Option.isNone(status) === true) {
      results.push({ _tag: 'unreachable', ...identity, memoryKiB, reason: 'status-unreadable' })
      continue
    }
    if (idleSinceMs !== undefined) {
      const started = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ start_time: Schema.String })),
      )(Option.isSome(statusRun) === true ? statusRun.value.stdout : '').pipe(Effect.option)
      const startedMs = Option.isSome(started) === true ? Date.parse(started.value.start_time) : NaN
      if (Number.isFinite(startedMs) === false || startedMs > idleSinceMs) {
        results.push({ _tag: 'kept-active', ...identity })
        continue
      }
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
    if (beforeKill !== undefined && (yield* beforeKill()) === false) {
      results.push({ _tag: 'kept-active', ...identity })
      continue
    }
    const observedLogWriteMs = yield* newestBuckLogWriteMs(daemon)
    if (observedLogWriteMs !== decidedLogWriteMs) {
      results.push({ _tag: 'kept-active', ...identity })
      continue
    }
    const killRun = yield* runBuck2({ binary, daemon, subcommand: 'kill' })
    if (Option.isNone(killRun) === true || killRun.value.exitCode !== 0) {
      results.push({ _tag: 'unreachable', ...identity, memoryKiB, reason: 'kill-failed' })
      continue
    }
    const exitedPid = /Buck2 daemon pid (\d+) has exited/u.exec(killRun.value.stderr)?.[1]
    if (exitedPid === undefined) {
      results.push({ _tag: 'unreachable', ...identity, memoryKiB, reason: 'kill-found-no-daemon' })
      continue
    }
    const logWriteAfterKillMs = yield* newestBuckLogWriteMs(daemon)
    let raced: string | undefined
    if (Number(exitedPid) !== daemon.pid) raced = `kill-stopped-other-pid-${exitedPid}`
    else if (logWriteAfterKillMs !== observedLogWriteMs) raced = 'command-log-written-during-kill'
    if (raced !== undefined && reportRaces === true) {
      yield* Effect.logWarning(
        `RACED stopping Buck2 daemon pid ${daemon.pid} (${daemon.daemonId}) at ${daemon.root}: ${raced}`,
      )
    }
    const stopped = {
      _tag: 'stopped' as const,
      ...identity,
      freedKiB: memoryKiB,
      ...(raced === undefined ? {} : { raced }),
    }
    results.push(stopped)
    if (afterStop !== undefined) yield* afterStop(stopped)
  }
  return results
})
