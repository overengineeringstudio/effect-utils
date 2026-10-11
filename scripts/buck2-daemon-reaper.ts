/**
 * Stops idle Buck2 daemons of the current user with Buck's own `buck2 kill`.
 *
 * The pinned daemon's `daemon_idle_timeout_s` counts command arrivals, not
 * running work, so it can stop a long build or an idle editor session. This
 * reaper only stops a daemon that reports no active command (an attached
 * `buck2 lsp` is an active command) and whose last command activity is older
 * than the idle threshold. Command activity is the newest event-log write
 * under `<root>/buck-out/<isolation>/log`: every streamed command writes there
 * while it runs. Daemons whose project root is gone are reported, never
 * signalled: the pinned CLI addresses a daemon only from inside its root.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

export type DaemonStatus = {
  readonly daemonId: string
  readonly pid: number
  readonly forkserverPid: number | undefined
  readonly projectRoot: string
  readonly isolationDir: string
  readonly startTimeMs: number
  readonly activeCommandCount: number
}

/** Facts gathered outside `buck2 status` for one daemon. */
export type DaemonObservation = {
  readonly daemon: DaemonStatus
  readonly rootExists: boolean
  /** Newest event-log write, or `undefined` when the log directory has no entries. */
  readonly lastLogWriteMs: number | undefined
}

export type ReapDecision =
  | { readonly _tag: 'keep-active'; readonly daemon: DaemonStatus }
  | { readonly _tag: 'keep-recent'; readonly daemon: DaemonStatus; readonly idleForMs: number }
  | { readonly _tag: 'kill-idle'; readonly daemon: DaemonStatus; readonly idleForMs: number }
  | { readonly _tag: 'report-gone'; readonly daemon: DaemonStatus }

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
  if (observation.rootExists === false) return { _tag: 'report-gone', daemon }
  if (daemon.activeCommandCount > 0) return { _tag: 'keep-active', daemon }
  // A daemon is never idle for longer than it has existed.
  const lastActivityMs = Math.max(daemon.startTimeMs, observation.lastLogWriteMs ?? 0)
  const idleForMs = nowMs - lastActivityMs
  return idleForMs >= idleThresholdMs
    ? { _tag: 'kill-idle', daemon, idleForMs }
    : { _tag: 'keep-recent', daemon, idleForMs }
}

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`buck2 status: ${field} is not a non-empty string`)
  return value
}

const requirePid = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || Number.isSafeInteger(value) === false || value <= 0)
    throw new Error(`buck2 status: ${field} is not a positive pid`)
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
    'isolation_dir' in value === false ||
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
  const startTimeMs = Date.parse(requireString(value.start_time, 'start_time'))
  if (Number.isFinite(startTimeMs) === false) throw new Error('buck2 status: invalid start_time')
  const forkserver = 'forkserver_pid' in value ? value.forkserver_pid : undefined
  return {
    daemonId: requireString(constraints.daemon_id, 'daemon_constraints.daemon_id'),
    pid: requirePid(processInfo.pid, 'process_info.pid'),
    forkserverPid:
      forkserver === null || forkserver === undefined
        ? undefined
        : requirePid(forkserver, 'forkserver_pid'),
    projectRoot: requireString(value.project_root, 'project_root'),
    isolationDir: requireString(value.isolation_dir, 'isolation_dir'),
    startTimeMs,
    activeCommandCount: value.active_commands.length,
  }
}

const run = (command: readonly string[], cwd: string) => {
  const result = Bun.spawnSync([...command], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

/**
 * `buck2 status --all` resolves `~/.buck/buckd` only from inside a project
 * root, so it runs from a throwaway empty root. Status never starts a daemon.
 */
export const discoverDaemons = (buck2: string): DaemonStatus[] => {
  const anchor = mkdtempSync(join(tmpdir(), 'buck2-daemon-reaper-'))
  try {
    writeFileSync(join(anchor, '.buckconfig'), '[cells]\n  root = .\n')
    writeFileSync(join(anchor, '.buckroot'), '')
    const result = run([buck2, 'status', '--all'], anchor)
    if (result.exitCode !== 0)
      throw new Error(`buck2 status --all exited ${result.exitCode}: ${result.stderr.trim()}`)
    const parsed: unknown = JSON.parse(result.stdout)
    if (Array.isArray(parsed) === false) throw new Error('buck2 status --all: expected an array')
    return parsed.map(decodeDaemonStatus)
  } finally {
    rmSync(anchor, { recursive: true, force: true })
  }
}

const rootExists = (root: string): boolean => {
  try {
    return statSync(root).isDirectory()
  } catch {
    return false
  }
}

/** Newest mtime among the isolation's event-log entries (`InvocationPaths::log_dir`). */
export const lastLogWriteMs = (daemon: DaemonStatus): number | undefined => {
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

export type KillOutcome =
  | { readonly _tag: 'killed'; readonly freedKiB: number }
  | { readonly _tag: 'skipped'; readonly reason: string }

/**
 * Re-reads the daemon from its own root immediately before `buck2 kill` and
 * aborts on any identity change, new command, or new log activity.
 */
export const killIfStillIdle = ({
  buck2,
  daemon,
  idleThresholdMs,
  now,
}: {
  readonly buck2: string
  readonly daemon: DaemonStatus
  readonly idleThresholdMs: number
  readonly now: () => number
}): KillOutcome => {
  const scoped = [buck2, '--isolation-dir', daemon.isolationDir]
  const recheck = run([...scoped, 'status'], daemon.projectRoot)
  if (recheck.exitCode !== 0) return { _tag: 'skipped', reason: 'recheck-failed' }
  let fresh: DaemonStatus
  try {
    fresh = decodeDaemonStatus(JSON.parse(recheck.stdout))
  } catch {
    // Includes the plain-text "no buckd running" answer.
    return { _tag: 'skipped', reason: 'recheck-unreadable' }
  }
  if (
    fresh.daemonId !== daemon.daemonId ||
    fresh.pid !== daemon.pid ||
    fresh.projectRoot !== daemon.projectRoot
  )
    return { _tag: 'skipped', reason: 'identity-changed' }
  const decision = decideReap({
    observation: { daemon: fresh, rootExists: true, lastLogWriteMs: lastLogWriteMs(fresh) },
    nowMs: now(),
    idleThresholdMs,
  })
  if (decision._tag !== 'kill-idle') return { _tag: 'skipped', reason: decision._tag }
  const freedKiB = memoryKiB([fresh.pid, fresh.forkserverPid])
  const kill = run([...scoped, 'kill'], daemon.projectRoot)
  if (kill.exitCode !== 0) return { _tag: 'skipped', reason: `kill-exited-${kill.exitCode}` }
  return { _tag: 'killed', freedKiB }
}

export type ReapEntry = {
  readonly decision: ReapDecision['_tag']
  readonly daemonId: string
  readonly pid: number
  readonly forkserverPid: number | undefined
  readonly projectRoot: string
  readonly isolationDir: string
  readonly idleForMs: number | undefined
  /** RSS plus swap of daemon and forkserver when sampled. */
  readonly memoryKiB: number
  readonly outcome: KillOutcome | undefined
}

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
  discoverDaemons(buck2)
    .filter(
      (daemon) =>
        rootPrefixes.length === 0 ||
        rootPrefixes.some((prefix) => daemon.projectRoot.startsWith(prefix)),
    )
    .map((daemon) => {
      const exists = rootExists(daemon.projectRoot)
      const decision = decideReap({
        observation: {
          daemon,
          rootExists: exists,
          lastLogWriteMs: exists === true ? lastLogWriteMs(daemon) : undefined,
        },
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
