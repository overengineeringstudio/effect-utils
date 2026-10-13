/**
 * Stops idle Buck2 daemons of the current user with Buck's own `buck2 kill`.
 *
 * The pinned daemon's `daemon_idle_timeout_s` counts command arrivals, not
 * running work, so it can stop a long build or an idle editor session. This
 * reaper only stops a daemon that reports no active command (an attached
 * `buck2 lsp` is an active command) and whose last command activity is older
 * than the idle threshold. Command activity is the newest event-log file write
 * under `<root>/buck-out/<isolation>/log`: every streamed command writes there.
 *
 * `buck2 kill` has no conditional form, so a command arriving between the
 * final status read and the kill is interrupted. The reaper narrows that
 * window (all sampling happens before the final read, which is immediately
 * followed by the kill) and reports any detected race as `raced`.
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

/**
 * Newest mtime among the isolation's event-log files (`InvocationPaths::log_dir`).
 * Directories are ignored: `buck2 kill` itself creates a per-invocation directory there.
 */
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
      const entryStat = statSync(join(logDir, entry))
      if (entryStat.isFile() === false) continue
      newest = newest === undefined ? entryStat.mtimeMs : Math.max(newest, entryStat.mtimeMs)
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
  /** Stopped, but evidence shows a command or another daemon met the kill. */
  | { readonly _tag: 'raced'; readonly freedKiB: number; readonly reason: string }
  | { readonly _tag: 'skipped'; readonly reason: string }

/**
 * Samples memory first, then re-observes the daemon and kills it with nothing
 * in between. Aborts on any identity change, new command, or event-log write
 * since the decision. After the kill, a different exited pid or a new event
 * log means the kill met work it was not meant for: the outcome is `raced`.
 */
export const killIfStillIdle = ({
  buck2,
  daemon,
  decidedLastLogWriteMs,
  idleThresholdMs,
  now,
}: {
  readonly buck2: string
  readonly daemon: DaemonProcess
  /** Newest event-log write seen by the observation that decided `kill-idle`. */
  readonly decidedLastLogWriteMs: number | undefined
  readonly idleThresholdMs: number
  readonly now: () => number
}): KillOutcome => {
  const freedKiB = memoryKiB([daemon.pid, daemon.forkserverPid])
  const observation = observeDaemon({ buck2, daemon })
  const decision = decideReap({ observation, nowMs: now(), idleThresholdMs })
  if (decision._tag !== 'kill-idle' || observation._tag !== 'observed')
    return { _tag: 'skipped', reason: decision._tag }
  if (observation.lastLogWriteMs !== decidedLastLogWriteMs)
    return { _tag: 'skipped', reason: 'log-activity-since-decision' }
  const kill = Bun.spawnSync([buck2, '--isolation-dir', daemon.isolationDir, 'kill'], {
    cwd: daemon.projectRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: statusTimeoutMs,
  })
  if (kill.exitCode !== 0) return { _tag: 'skipped', reason: `kill-exit-${kill.exitCode}` }
  const exitedPid = /Buck2 daemon pid (\d+) has exited/u.exec(kill.stderr.toString())?.[1]
  if (exitedPid === undefined) return { _tag: 'skipped', reason: 'kill-found-no-daemon' }
  if (Number(exitedPid) !== daemon.pid)
    return { _tag: 'raced', freedKiB, reason: `kill-stopped-other-pid-${exitedPid}` }
  if (lastLogWriteMs(daemon) !== observation.lastLogWriteMs)
    return { _tag: 'raced', freedKiB, reason: 'command-log-written-during-kill' }
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
      const observation = observeDaemon({ buck2, daemon })
      const decision = decideReap({ observation, nowMs: now(), idleThresholdMs })
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
          decision._tag === 'kill-idle' && dryRun === false && observation._tag === 'observed'
            ? killIfStillIdle({
                buck2,
                daemon,
                decidedLastLogWriteMs: observation.lastLogWriteMs,
                idleThresholdMs,
                now,
              })
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
  for (const entry of entries) {
    if (entry.outcome?._tag === 'raced')
      console.error(
        `buck2-daemon-reaper: RACED stopping pid ${entry.pid} (${entry.daemonId}) at ${entry.projectRoot}: ${entry.outcome.reason}`,
      )
  }
  console.log(JSON.stringify(entries, undefined, 2))
}
