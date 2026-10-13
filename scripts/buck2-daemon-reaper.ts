/**
 * Stops idle Buck2 daemons of the current user with Buck's own `buck2 kill`.
 *
 * The pinned daemon's `daemon_idle_timeout_s` counts command arrivals, not
 * running work, so it can stop a long build or an idle editor session. This
 * reaper only stops a daemon that reports no active command (an attached
 * `buck2 lsp` is an active command) and whose last command activity is older
 * than the idle threshold. Command activity is the newest event-log write
 * under `<root>/buck-out/<isolation>/log`: every streamed command writes there.
 *
 * Daemons are found from the user's live processes, not `buck2 status --all`,
 * which probes every historical `~/.buck/buckd` entry and can hang on one
 * unresponsive endpoint. Daemons whose project root is gone are reported,
 * never signalled: the pinned CLI addresses a daemon only from inside its root.
 */
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

/** A live Buck2 daemon process of the current user, identified from `/proc`. */
export type DaemonProcess = {
  readonly pid: number
  readonly daemonId: string
  readonly isolationDir: string
  readonly projectRoot: string
  /** The daemon's cwd (`<root>/buck-out/<isolation>`) was unlinked or the root is no directory. */
  readonly rootGone: boolean
  readonly forkserverPid: number | undefined
}

/** The fields of `buck2 status` the policy reads. */
export type DaemonStatus = {
  readonly daemonId: string
  readonly pid: number
  readonly projectRoot: string
  readonly startTimeMs: number
  readonly activeCommandCount: number
}

/** What one root-scoped status read established about a daemon process. */
export type DaemonObservation =
  | { readonly _tag: 'gone'; readonly daemon: DaemonProcess }
  | { readonly _tag: 'unreachable'; readonly daemon: DaemonProcess; readonly reason: string }
  | {
      readonly _tag: 'observed'
      readonly daemon: DaemonProcess
      readonly status: DaemonStatus
      /** Newest event-log write, or `undefined` when the log directory has no entries. */
      readonly lastLogWriteMs: number | undefined
    }

/** The reaper's per-daemon verdict; only `kill-idle` leads to `buck2 kill`. */
export type ReapDecision =
  | { readonly _tag: 'report-gone'; readonly daemon: DaemonProcess }
  | { readonly _tag: 'keep-unreachable'; readonly daemon: DaemonProcess; readonly reason: string }
  | { readonly _tag: 'keep-active'; readonly daemon: DaemonProcess }
  | { readonly _tag: 'keep-recent'; readonly daemon: DaemonProcess; readonly idleForMs: number }
  | { readonly _tag: 'kill-idle'; readonly daemon: DaemonProcess; readonly idleForMs: number }

/** Pure policy: what to do with one observed daemon at `nowMs`. */
export const decideReap = ({
  observation,
  nowMs,
  idleThresholdMs,
}: {
  readonly observation: DaemonObservation
  readonly nowMs: number
  readonly idleThresholdMs: number
}): ReapDecision => {
  const { daemon } = observation
  if (observation._tag === 'gone') return { _tag: 'report-gone', daemon }
  if (observation._tag === 'unreachable')
    return { _tag: 'keep-unreachable', daemon, reason: observation.reason }
  const { status } = observation
  if (status.activeCommandCount > 0) return { _tag: 'keep-active', daemon }
  // A daemon is never idle for longer than it has existed.
  const idleForMs = nowMs - Math.max(status.startTimeMs, observation.lastLogWriteMs ?? 0)
  return idleForMs >= idleThresholdMs
    ? { _tag: 'kill-idle', daemon, idleForMs }
    : { _tag: 'keep-recent', daemon, idleForMs }
}

/**
 * Recognizes a pinned daemon from its argv (`… --isolation-dir <i> daemon
 * --daemon-id <id> …`) and cwd. The daemon chdirs to its project root
 * (`buck2_daemon/src/daemon.rs:245`); established daemons are observed in
 * `<root>/buck-out/<i>`. Linux appends ` (deleted)` to an unlinked cwd. The derived root is only a
 * candidate: a kill requires status read from it to report this pid and id.
 */
export const parseDaemonProcess = ({
  pid,
  argv,
  cwd,
}: {
  readonly pid: number
  readonly argv: readonly string[]
  readonly cwd: string
}): Omit<DaemonProcess, 'rootGone' | 'forkserverPid'> & { readonly cwdDeleted: boolean } => {
  const isolationDir = argv[argv.indexOf('--isolation-dir') + 1]
  const daemonId = argv[argv.indexOf('--daemon-id') + 1]
  if (
    argv.includes('daemon') === false ||
    argv.includes('--isolation-dir') === false ||
    argv.includes('--daemon-id') === false ||
    isolationDir === undefined ||
    daemonId === undefined
  )
    throw new Error(`pid ${pid} is not a Buck2 daemon`)
  const cwdDeleted = cwd.endsWith(' (deleted)')
  const directory = cwdDeleted === true ? cwd.slice(0, -' (deleted)'.length) : cwd
  const suffix = `/buck-out/${isolationDir}`
  return {
    pid,
    daemonId,
    isolationDir,
    projectRoot:
      directory.endsWith(suffix) === true ? directory.slice(0, -suffix.length) : directory,
    cwdDeleted,
  }
}

type ProcEntry = {
  readonly pid: number
  readonly parentPid: number
  readonly argv: readonly string[]
  readonly cwd: string
}

/** Buck2 processes (daemons and forkservers) whose every uid is the current user's. */
const readOwnBuckProcesses = (): ProcEntry[] => {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('buck2-daemon-reaper requires a POSIX uid')
  const entries: ProcEntry[] = []
  for (const name of readdirSync('/proc')) {
    if (/^\d+$/u.test(name) === false) continue
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8')
      const uids = /^Uid:\s+(.*)$/mu.exec(status)?.[1]?.trim().split(/\s+/u)
      if (uids === undefined || uids.every((value) => value === String(uid)) === false) continue
      if (readlinkSync(`/proc/${name}/exe`).endsWith('/buck2') === false) continue
      entries.push({
        pid: Number(name),
        parentPid: Number(/^PPid:\s+(\d+)$/mu.exec(status)?.[1]),
        argv: readFileSync(`/proc/${name}/cmdline`, 'utf8')
          .split('\0')
          .filter((a) => a !== ''),
        cwd: readlinkSync(`/proc/${name}/cwd`),
      })
    } catch {
      // The process exited mid-scan.
    }
  }
  return entries
}

/** The current user's live Buck2 daemons from `/proc`, with their forkserver when present. */
export const listDaemonProcesses = (): DaemonProcess[] => {
  const processes = readOwnBuckProcesses()
  return processes
    .filter((entry) => entry.argv.includes('daemon') && entry.argv.includes('--daemon-id'))
    .map((entry) => {
      const { cwdDeleted, pid, daemonId, isolationDir, projectRoot } = parseDaemonProcess(entry)
      let rootIsDirectory = false
      try {
        rootIsDirectory = statSync(projectRoot).isDirectory()
      } catch {
        // Missing root.
      }
      return {
        pid,
        daemonId,
        isolationDir,
        projectRoot,
        rootGone: cwdDeleted === true || rootIsDirectory === false,
        forkserverPid: processes.find(
          (child) => child.parentPid === entry.pid && child.argv[1] === 'forkserver',
        )?.pid,
      }
    })
}

const requireString = ({ value, field }: { value: unknown; field: string }): string => {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`buck2 status: ${field} is not a non-empty string`)
  return value
}

/** Decodes one `buck2 status` object (pinned 2026-09-01 field names). */
export const decodeDaemonStatus = (value: unknown): DaemonStatus => {
  if (
    typeof value !== 'object' ||
    value === null ||
    'process_info' in value === false ||
    'daemon_constraints' in value === false ||
    'active_commands' in value === false ||
    'project_root' in value === false ||
    'start_time' in value === false
  )
    throw new Error('buck2 status: entry lacks daemon status fields')
  const { process_info: processInfo, daemon_constraints: constraints } = value
  if (typeof processInfo !== 'object' || processInfo === null || 'pid' in processInfo === false)
    throw new Error('buck2 status: process_info.pid missing')
  if (
    typeof constraints !== 'object' ||
    constraints === null ||
    'daemon_id' in constraints === false
  )
    throw new Error('buck2 status: daemon_constraints.daemon_id missing')
  if (Array.isArray(value.active_commands) === false)
    throw new Error('buck2 status: active_commands is not an array')
  const { pid } = processInfo
  if (typeof pid !== 'number' || Number.isSafeInteger(pid) === false || pid <= 0)
    throw new Error('buck2 status: process_info.pid is not a positive pid')
  const startTimeMs = Date.parse(requireString({ value: value.start_time, field: 'start_time' }))
  if (Number.isFinite(startTimeMs) === false) throw new Error('buck2 status: invalid start_time')
  return {
    daemonId: requireString({
      value: constraints.daemon_id,
      field: 'daemon_constraints.daemon_id',
    }),
    pid,
    projectRoot: requireString({ value: value.project_root, field: 'project_root' }),
    startTimeMs,
    activeCommandCount: value.active_commands.length,
  }
}

/** Newest mtime among the isolation's event-log entries (`InvocationPaths::log_dir`). */
export const lastLogWriteMs = (daemon: DaemonProcess): number | undefined => {
  const logDir = join(daemon.projectRoot, 'buck-out', daemon.isolationDir, 'log')
  let entries: string[]
  try {
    entries = readdirSync(logDir)
  } catch {
    return undefined
  }
  let newest: number | undefined
  for (const entry of entries) {
    try {
      const { mtimeMs } = statSync(join(logDir, entry))
      newest = newest === undefined ? mtimeMs : Math.max(newest, mtimeMs)
    } catch {
      // Buck rotates old logs concurrently; a vanished entry carries no activity.
    }
  }
  return newest
}

const statusTimeoutMs = 30_000

/** Reads one daemon's status from its own root; any doubt makes it unreachable. */
export const observeDaemon = ({
  buck2,
  daemon,
}: {
  readonly buck2: string
  readonly daemon: DaemonProcess
}): DaemonObservation => {
  if (daemon.rootGone === true) return { _tag: 'gone', daemon }
  const result = Bun.spawnSync([buck2, '--isolation-dir', daemon.isolationDir, 'status'], {
    cwd: daemon.projectRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: statusTimeoutMs,
  })
  if (result.exitCode !== 0)
    return { _tag: 'unreachable', daemon, reason: `status-exit-${result.exitCode}` }
  let status: DaemonStatus
  try {
    status = decodeDaemonStatus(JSON.parse(result.stdout.toString()))
  } catch {
    // Includes the plain-text "no buckd running" answer.
    return { _tag: 'unreachable', daemon, reason: 'status-unreadable' }
  }
  if (status.pid !== daemon.pid || status.daemonId !== daemon.daemonId)
    return { _tag: 'unreachable', daemon, reason: 'status-identity-mismatch' }
  return { _tag: 'observed', daemon, status, lastLogWriteMs: lastLogWriteMs(daemon) }
}

/** RSS plus swap in KiB for the given processes; exited processes count 0. */
export const memoryKiB = (pids: readonly (number | undefined)[]): number => {
  let total = 0
  for (const pid of pids) {
    if (pid === undefined) continue
    let status: string
    try {
      status = readFileSync(`/proc/${pid}/status`, 'utf8')
    } catch {
      continue
    }
    for (const match of status.matchAll(/^(?:VmRSS|VmSwap):\s+(\d+) kB$/gmu))
      total += Number(match[1])
  }
  return total
}

/** Result of the re-checked kill attempt for one `kill-idle` daemon. */
export type KillOutcome =
  | { readonly _tag: 'killed'; readonly freedKiB: number }
  | { readonly _tag: 'skipped'; readonly reason: string }

/**
 * Re-observes the daemon immediately before `buck2 kill` and aborts on any
 * identity change, new command, or new log activity.
 */
export const killIfStillIdle = ({
  buck2,
  daemon,
  idleThresholdMs,
  now,
}: {
  readonly buck2: string
  readonly daemon: DaemonProcess
  readonly idleThresholdMs: number
  readonly now: () => number
}): KillOutcome => {
  const decision = decideReap({
    observation: observeDaemon({ buck2, daemon }),
    nowMs: now(),
    idleThresholdMs,
  })
  if (decision._tag !== 'kill-idle') return { _tag: 'skipped', reason: decision._tag }
  const freedKiB = memoryKiB([daemon.pid, daemon.forkserverPid])
  const kill = Bun.spawnSync([buck2, '--isolation-dir', daemon.isolationDir, 'kill'], {
    cwd: daemon.projectRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: statusTimeoutMs,
  })
  if (kill.exitCode !== 0) return { _tag: 'skipped', reason: `kill-exit-${kill.exitCode}` }
  return { _tag: 'killed', freedKiB }
}

/** One JSON log line per daemon: decision, identity, idle evidence, memory and kill outcome. */
export type ReapEntry = {
  readonly decision: ReapDecision['_tag']
  readonly daemonId: string
  readonly pid: number
  readonly forkserverPid: number | undefined
  readonly projectRoot: string
  readonly isolationDir: string
  readonly idleForMs: number | undefined
  readonly reason: string | undefined
  /** RSS plus swap of daemon and forkserver when sampled. */
  readonly memoryKiB: number
  readonly outcome: KillOutcome | undefined
}

/** Classifies every live daemon of the current user and kills the idle ones unless `dryRun`. */
export const reap = ({
  buck2,
  idleThresholdMs,
  rootPrefixes,
  dryRun,
  now = Date.now,
}: {
  readonly buck2: string
  readonly idleThresholdMs: number
  /** Only daemons under these roots are considered; empty means all of the user's daemons. */
  readonly rootPrefixes: readonly string[]
  readonly dryRun: boolean
  /** Clock seam for tests; decisions and pre-kill rechecks read it separately. */
  readonly now?: () => number
}): readonly ReapEntry[] =>
  listDaemonProcesses()
    .filter(
      (daemon) =>
        rootPrefixes.length === 0 ||
        rootPrefixes.some((prefix) => daemon.projectRoot.startsWith(prefix)),
    )
    .map((daemon) => {
      const decision = decideReap({
        observation: observeDaemon({ buck2, daemon }),
        nowMs: now(),
        idleThresholdMs,
      })
      return {
        decision: decision._tag,
        daemonId: daemon.daemonId,
        pid: daemon.pid,
        forkserverPid: daemon.forkserverPid,
        projectRoot: daemon.projectRoot,
        isolationDir: daemon.isolationDir,
        idleForMs: 'idleForMs' in decision ? decision.idleForMs : undefined,
        reason: 'reason' in decision ? decision.reason : undefined,
        memoryKiB: memoryKiB([daemon.pid, daemon.forkserverPid]),
        outcome:
          decision._tag === 'kill-idle' && dryRun === false
            ? killIfStillIdle({ buck2, daemon, idleThresholdMs, now })
            : undefined,
      }
    })

if (import.meta.main === true) {
  const { values } = parseArgs({
    options: {
      buck2: { type: 'string' },
      'idle-seconds': { type: 'string', default: String(3 * 60 * 60) },
      'root-prefix': { type: 'string', multiple: true, default: [] },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (values.buck2 === undefined) throw new Error('--buck2 <raw buck2 binary> is required')
  const idleSeconds = Number(values['idle-seconds'])
  if (Number.isFinite(idleSeconds) === false || idleSeconds <= 0)
    throw new Error('--idle-seconds must be a positive number')
  const entries = reap({
    buck2: values.buck2,
    idleThresholdMs: idleSeconds * 1000,
    rootPrefixes: values['root-prefix'],
    dryRun: values['dry-run'],
  })
  console.log(JSON.stringify(entries, undefined, 2))
}
