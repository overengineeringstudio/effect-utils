/**
 * Live-process in-use probe
 *
 * The deletion lease only excludes an activation that takes it. A shell or agent
 * session that was already sitting inside a worktree holds no lease, and on
 * Unix a directory rename is invisible to a process already in that directory:
 * its cwd silently follows the inode into `.archive/`, and the following git
 * bookkeeping strips the worktree out from under the live session. That is a
 * real incident class, not a hypothetical.
 *
 * So destructive reclamation additionally asks the strictly stronger question
 * the liveness manifest cannot answer: is a live OS process working inside this
 * directory right now? Linux additionally supports cwd/root/open-file/mapping
 * references. Strict scopes require complete evidence; GC-owner scope retains
 * readable holders, counts unreadable foreign processes and requires own-UID
 * completeness (with bounded lsof fallback). Unsupported scans keep the tree.
 */

import { Effect, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import { type AbsoluteDirPath } from '@overeng/effect-path'

/** The process that holds a worktree, and the in-worktree path proving it. */
export interface InUseHolder {
  readonly pid: number
  readonly path: string
}

/** Probe outcome. `unknown` MUST be treated as in-use by callers. */
export type InUseResult = (
  | { readonly _tag: 'free' }
  | { readonly _tag: 'in-use'; readonly holder: InUseHolder }
  | {
      readonly _tag: 'unknown'
      readonly reason: 'no-proc' | 'scan-failed' | 'inaccessible-process' | 'own-uid-unreadable'
    }
) & {
  readonly ignoredForeignProcesses?: number | undefined
  readonly exemptProcesses?: ReadonlyArray<ExemptProcess> | undefined
}

/** One observed process cwd. */
export interface ProcessCwd {
  readonly pid: number
  readonly path: string
}

interface DarwinProcessCwd extends ProcessCwd {
  readonly parentPid: number | undefined
}

const normalizePath = (path: string): string => path.replace(/\/+$/, '')

/**
 * True when `candidate` is the worktree itself or a path inside it.
 *
 * Compared on normalized boundaries so a sibling like `<worktree>.archive-old`
 * never matches by raw string prefix.
 */
export const isInsideWorktree = ({
  candidate,
  worktreePath,
}: {
  candidate: string
  worktreePath: string
}): boolean => {
  const worktree = normalizePath(worktreePath)
  const path = normalizePath(candidate)
  return path === worktree || path.startsWith(`${worktree}/`) === true
}

/**
 * Pure classifier: the first process whose cwd is inside the worktree and which
 * is not excluded.
 *
 * `excludePids` carries this gc process and its descendants — a `git` child
 * megarepo itself spawned with a cwd inside the worktree must never self-veto.
 * Keeping it a parameter is what makes this seam unit-testable and lets the
 * integration test observe a real spawned holder.
 */
export const classifyInUse = ({
  processes,
  worktreePath,
  excludePids,
}: {
  processes: ReadonlyArray<ProcessCwd>
  worktreePath: string
  excludePids: ReadonlySet<number>
}): InUseResult => {
  for (const entry of processes) {
    if (excludePids.has(entry.pid) === true) continue
    if (isInsideWorktree({ candidate: entry.path, worktreePath }) === false) continue
    return { _tag: 'in-use', holder: { pid: entry.pid, path: entry.path } }
  }
  return { _tag: 'free' }
}

const parsePpid = (statusContent: string): number | undefined => {
  const line = statusContent.split('\n').find((entry) => entry.startsWith('PPid:') === true)
  if (line === undefined) return undefined
  const parsed = Number.parseInt(line.slice('PPid:'.length).trim(), 10)
  return Number.isSafeInteger(parsed) === true && parsed >= 0 ? parsed : undefined
}

const parsePidField = (value: string): number | undefined => {
  const parsed = Number.parseInt(value, 10)
  return `${parsed}` === value && Number.isSafeInteger(parsed) === true && parsed > 0
    ? parsed
    : undefined
}

/**
 * Parse `lsof -d cwd -FpnR` output into one cwd record per visible process.
 *
 * Process fields precede the selected cwd file record. Keeping the parser pure
 * makes the Darwin process-table contract independently testable on Linux.
 */
export const parseLsofProcessCwds = (
  lines: ReadonlyArray<string>,
): ReadonlyArray<DarwinProcessCwd> => {
  const observed: Array<DarwinProcessCwd> = []
  let pid: number | undefined
  let parentPid: number | undefined
  let path: string | undefined

  const flush = () => {
    if (pid !== undefined && path !== undefined) observed.push({ pid, parentPid, path })
  }

  for (const line of lines) {
    const field = line[0]
    const value = line.slice(1)
    if (field === 'p') {
      flush()
      pid = parsePidField(value)
      parentPid = undefined
      path = undefined
    } else if (field === 'R') {
      parentPid = parsePidField(value)
    } else if (field === 'n') {
      path = value
    }
  }
  flush()
  return observed
}

/**
 * Walk a pid's parent chain; `true` when `ancestorPid` is reached.
 *
 * Climbing from the rare in-worktree match is far cheaper than materializing
 * the whole process tree, and the depth bound keeps a corrupted or recycled
 * chain from looping.
 */
const hasAncestor = ({
  fs,
  pid,
  ancestorPid,
}: {
  fs: FileSystem.FileSystem
  pid: number
  ancestorPid: number
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    let current = pid
    for (let depth = 0; depth < 64; depth += 1) {
      if (current === ancestorPid) return true
      if (current <= 1) return false
      const status = yield* fs
        .readFileString(`/proc/${current}/status`)
        .pipe(Effect.orElseSucceed(() => undefined))
      const parent = status === undefined ? undefined : parsePpid(status)
      if (parent === undefined) return false
      current = parent
    }
    return false
  })

/**
 * Read every readable process cwd from `/proc`.
 *
 * A pid that vanishes mid-scan, or whose cwd belongs to another user, is simply
 * not evidence — those are skipped rather than failing the whole probe, because
 * refusing on any unreadable pid would make the probe permanently `unknown` on
 * a shared host and thereby disable reclamation entirely.
 */
const readProcessCwds = (
  fs: FileSystem.FileSystem,
): Effect.Effect<ReadonlyArray<ProcessCwd> | undefined> =>
  Effect.gen(function* () {
    const entries = yield* fs.readDirectory('/proc').pipe(Effect.orElseSucceed(() => undefined))
    if (entries === undefined) return undefined
    const pids = entries.flatMap((entry) => {
      const pid = Number.parseInt(entry, 10)
      return `${pid}` === entry && Number.isSafeInteger(pid) === true && pid > 0 ? [pid] : []
    })
    const observed = yield* Effect.forEach(
      pids,
      (pid) =>
        fs.readLink(`/proc/${pid}/cwd`).pipe(
          Effect.map((path) => ({ pid, path })),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 16 },
    )
    return observed.flatMap((entry) => (entry === undefined ? [] : [entry]))
  })

/** Bounded native evidence queries; drain both streams and release the child on timeout. */
const readBoundedProcessOutput = Effect.fn('store.readBoundedProcessOutput')(function* ({
  binary,
  args,
  env,
}: {
  binary: string
  args: ReadonlyArray<string>
  env?: Readonly<Record<string, string>>
}) {
  const spawner = yield* ChildProcessSpawner
  return yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(binary, args, env === undefined ? {} : { env, extendEnv: false }),
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
  }).pipe(Effect.scoped, Effect.timeout('5 seconds'), Effect.option)
})

/** Read macOS process cwd and parent evidence from the system `lsof`. */
const readDarwinProcessCwds: Effect.Effect<
  ReadonlyArray<DarwinProcessCwd> | undefined,
  never,
  ChildProcessSpawner
> = Effect.gen(function* () {
  const output = yield* readBoundedProcessOutput({
    binary: '/usr/sbin/lsof',
    args: ['-n', '-P', '-w', '-d', 'cwd', '-FpnR'],
  })
  if (output._tag === 'None' || output.value.exitCode !== 0) return undefined
  const observed = parseLsofProcessCwds(output.value.stdout.split('\n'))
  return observed.some((entry) => entry.pid === process.pid) === true ? observed : undefined
})

const hasAncestorInTable = ({
  parentByPid,
  pid,
  ancestorPid,
}: {
  parentByPid: ReadonlyMap<number, number | undefined>
  pid: number
  ancestorPid: number
}): boolean => {
  let current = pid
  for (let depth = 0; depth < 64; depth += 1) {
    if (current === ancestorPid) return true
    if (current <= 1) return false
    const parent = parentByPid.get(current)
    if (parent === undefined) return false
    current = parent
  }
  return false
}

/**
 * Probe whether a live process is working inside `worktreePath`.
 *
 * `selfPid` defaults to this process; it and its descendants are excluded so
 * megarepo's own git children can never veto its work.
 */
export const readWorktreeInUse = ({
  worktreePath,
  selfPid = process.pid,
}: {
  worktreePath: AbsoluteDirPath | string
  selfPid?: number | undefined
}): Effect.Effect<InUseResult, never, FileSystem.FileSystem | ChildProcessSpawner> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const hasProc = yield* fs.exists('/proc').pipe(Effect.orElseSucceed(() => false))
    const canonicalWorktreePath = yield* fs
      .realPath(worktreePath)
      .pipe(Effect.orElseSucceed(() => worktreePath))

    if (hasProc === true) {
      const processes = yield* readProcessCwds(fs)
      if (processes === undefined) return { _tag: 'unknown', reason: 'scan-failed' } as const
      const inside = processes.filter((entry) =>
        isInsideWorktree({ candidate: entry.path, worktreePath: canonicalWorktreePath }),
      )
      const excluded = yield* Effect.forEach(
        inside,
        (entry) =>
          hasAncestor({ fs, pid: entry.pid, ancestorPid: selfPid }).pipe(
            Effect.map((self) => (self === true ? [entry.pid] : [])),
          ),
        { concurrency: 8 },
      )
      return classifyInUse({
        processes: inside,
        worktreePath: canonicalWorktreePath,
        excludePids: new Set(excluded.flat()),
      })
    }

    if (process.platform !== 'darwin') {
      return { _tag: 'unknown', reason: 'no-proc' } as const
    }
    const processes = yield* readDarwinProcessCwds
    if (processes === undefined) return { _tag: 'unknown', reason: 'scan-failed' } as const
    const inside = processes.filter((entry) =>
      isInsideWorktree({ candidate: entry.path, worktreePath: canonicalWorktreePath }),
    )
    const parentByPid = new Map(processes.map((entry) => [entry.pid, entry.parentPid]))
    return classifyInUse({
      processes: inside,
      worktreePath: canonicalWorktreePath,
      excludePids: new Set(
        inside
          .filter((entry) =>
            hasAncestorInTable({ parentByPid, pid: entry.pid, ancestorPid: selfPid }),
          )
          .map((entry) => entry.pid),
      ),
    })
  })

/** Kernel reference kinds that can hold a path below a worktree. */
export type ProcessReferenceKind = 'cwd' | 'root' | 'fd' | 'map'

/** One kernel-reported path a live process holds. */
export interface ProcessReference {
  readonly pid: number
  readonly kind: ProcessReferenceKind
  readonly path: string
}

/** A process lifetime: kernel stat field 22 is kept as decimal ticks, not a number. */
export interface ProcessIdentity {
  readonly pid: number
  readonly startTime: string
}

/** An exact own-UID lifetime whose unreadable native evidence GC may waive. */
export interface ExemptProcess {
  readonly pid: number
  readonly startTime: string
  readonly comm: string
  readonly rule: 'systemd-user-manager' | 'systemd-user-pam' | 'sshd-privilege-transition'
}

// These fixed daemon roles become non-dumpable after setuid/PAM transitions,
// with cwd '/' by design. Their readable references and children are still
// checked normally; capabilities alone never authorize an exemption.
const GC_OWNER_EXEMPTIONS = [
  { comm: 'systemd', rule: 'systemd-user-manager' },
  { comm: '(sd-pam)', rule: 'systemd-user-pam' },
  { comm: 'sshd-session', rule: 'sshd-privilege-transition' },
  { comm: 'sshd', rule: 'sshd-privilege-transition' },
] as const

/** Complete reference table, or why completeness cannot be proven. */
export type ProcessReferenceScan = (
  | {
      readonly _tag: 'complete'
      readonly references: ReadonlyArray<ProcessReference>
      readonly processIdentities: ReadonlyArray<ProcessIdentity>
    }
  | {
      readonly _tag: 'unknown'
      readonly reason: 'no-proc' | 'scan-failed' | 'inaccessible-process' | 'own-uid-unreadable'
      readonly pid?: number | undefined
      /** Partial readable evidence is retained for the GC-owner policy only. */
      readonly references?: ReadonlyArray<ProcessReference> | undefined
    }
) & {
  readonly ignoredForeignProcesses?: number | undefined
  readonly exemptProcesses?: ReadonlyArray<ExemptProcess> | undefined
}

/** `PF_KTHREAD` in `/proc/<pid>/stat` flags: no user address space or files. */
const PF_KTHREAD = 0x0020_0000

/**
 * Parse the parent pid, kernel-thread flag and start ticks from `/proc/<pid>/stat`.
 * `comm` may contain spaces and parentheses, so fields start after the last `)`.
 */
export const parseProcStat = (
  content: string,
):
  | {
      readonly parentPid: number
      readonly kernelThread: boolean
      readonly startTime: string
    }
  | undefined => {
  const close = content.lastIndexOf(')')
  if (close === -1) return undefined
  // After `)`: state(3), ppid(4), flags(9), and starttime(22).
  const fields = content
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const parentPid = Number(fields[1])
  const flags = Number(fields[6])
  const startTime = fields[19]
  if (
    Number.isSafeInteger(parentPid) === false ||
    parentPid < 0 ||
    Number.isSafeInteger(flags) === false ||
    flags < 0 ||
    startTime === undefined ||
    /^[0-9]+$/.test(startTime) === false
  ) {
    return undefined
  }
  return { parentPid, kernelThread: (flags & PF_KTHREAD) !== 0, startTime }
}

/** Kernel link targets of deleted files keep their former path plus this marker. */
const withoutDeletedMarker = (path: string): string => path.replace(/ \(deleted\)$/, '')

/** Absolute file paths mapped into a process, from `/proc/<pid>/maps`. */
export const parseProcMapsPaths = (content: string): ReadonlyArray<string> =>
  content.split('\n').flatMap((line) => {
    const match = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)
    return match?.[1] === undefined ? [] : [withoutDeletedMarker(match[1])]
  })

type ProcRead<TValue> =
  | { readonly _tag: 'value'; readonly value: TValue }
  | { readonly _tag: 'gone' }
  | { readonly _tag: 'denied' }

/** A vanished process is no evidence; every other failure is unreadable evidence. */
const procRead = <TValue>(
  effect: Effect.Effect<TValue, PlatformError>,
): Effect.Effect<ProcRead<TValue>> =>
  effect.pipe(
    Effect.map((value): ProcRead<TValue> => ({ _tag: 'value', value })),
    Effect.catch((error) =>
      Effect.succeed<ProcRead<TValue>>(
        error.reason._tag === 'NotFound' ? { _tag: 'gone' } : { _tag: 'denied' },
      ),
    ),
  )

type ProcessEntry =
  | { readonly _tag: 'gone' }
  | { readonly _tag: 'denied'; readonly pid: number }
  | {
      readonly _tag: 'process'
      readonly pid: number
      readonly parentPid: number
      readonly references: ReadonlyArray<ProcessReference>
      readonly identity: ProcessIdentity | undefined
      readonly incomplete?: boolean | undefined
      readonly foreign?: boolean | undefined
      exempt?: ExemptProcess | undefined
      readonly systemdUserManager?: boolean | undefined
    }

/** Real, effective, saved and filesystem uids from `/proc/<pid>/status`. */
export const parseProcUids = (content: string): ReadonlyArray<number> | undefined => {
  const line = content.split('\n').find((entry) => entry.startsWith('Uid:') === true)
  const uids = line?.slice('Uid:'.length).trim().split(/\s+/).map(Number)
  return uids !== undefined &&
    uids.length === 4 &&
    uids.every((uid) => Number.isSafeInteger(uid) === true && uid >= 0) === true
    ? uids
    : undefined
}

/** Missing links can be zombies or closing descriptors; other failures are unreadable. */
const readProcessReferencePaths = Effect.fn('store.readProcessReferencePaths')(function* ({
  fs,
  pid,
  retainPartial = false,
}: {
  fs: FileSystem.FileSystem
  pid: number
  retainPartial?: boolean
}) {
  const references: Array<ProcessReference> = []
  let complete = true
  for (const kind of ['cwd', 'root'] as const) {
    const link = yield* procRead(fs.readLink(`/proc/${pid}/${kind}`))
    if (link._tag === 'denied') {
      if (retainPartial === false) return { references, complete: false }
      complete = false
    }
    if (link._tag === 'value') {
      references.push({ pid, kind, path: withoutDeletedMarker(link.value) })
    }
  }
  const fds = yield* procRead(fs.readDirectory(`/proc/${pid}/fd`))
  if (fds._tag === 'denied') {
    if (retainPartial === false) return { references, complete: false }
    complete = false
  }
  const fdLinks = yield* Effect.forEach(
    fds._tag === 'value' ? fds.value : [],
    (fd) => procRead(fs.readLink(`/proc/${pid}/fd/${fd}`)),
    { concurrency: 32 },
  )
  for (const link of fdLinks) {
    if (link._tag === 'denied') {
      if (retainPartial === false) return { references, complete: false }
      complete = false
    }
    // Sockets, pipes and anonymous inodes are not filesystem paths.
    if (link._tag === 'value' && link.value.startsWith('/') === true) {
      references.push({ pid, kind: 'fd', path: withoutDeletedMarker(link.value) })
    }
  }
  const maps = yield* procRead(fs.readFileString(`/proc/${pid}/maps`))
  if (maps._tag === 'denied') complete = false
  if (maps._tag === 'value') {
    for (const path of new Set(parseProcMapsPaths(maps.value))) {
      references.push({ pid, kind: 'map', path })
    }
  }
  return { references, complete }
})

/** Mutable process names only identify an SSH role when its live parent is root-owned SSH. */
const readSshPrivilegedParent = Effect.fn('store.readSshPrivilegedParent')(function* ({
  fs,
  parentPid,
}: {
  fs: FileSystem.FileSystem
  parentPid: number
}) {
  const before = yield* procRead(fs.readFileString(`/proc/${parentPid}/stat`))
  const status = yield* procRead(fs.readFileString(`/proc/${parentPid}/status`))
  const after = yield* procRead(fs.readFileString(`/proc/${parentPid}/stat`))
  if (before._tag !== 'value' || after._tag !== 'value' || status._tag !== 'value') return false
  const parsed = parseProcStat(before.value)
  const checked = parseProcStat(after.value)
  const comm = before.value.slice(before.value.indexOf('(') + 1, before.value.lastIndexOf(')'))
  const checkedComm = after.value.slice(after.value.indexOf('(') + 1, after.value.lastIndexOf(')'))
  return (
    parsed?.kernelThread === false &&
    checked?.startTime === parsed.startTime &&
    checkedComm === comm &&
    (comm === 'sshd' || comm === 'sshd-session') &&
    parseProcUids(status.value)?.every((uid) => uid === 0) === true
  )
})

const readProcessEntry = ({
  fs,
  pid,
  ownUid,
  coveredStartTime,
  gcOwner = false,
}: {
  fs: FileSystem.FileSystem
  pid: number
  ownUid: number | undefined
  coveredStartTime: string | undefined
  gcOwner?: boolean
}): Effect.Effect<ProcessEntry> =>
  Effect.gen(function* () {
    const before = yield* procRead(fs.readFileString(`/proc/${pid}/stat`))
    if (before._tag === 'gone') return { _tag: 'gone' } as const
    const parsed = before._tag === 'value' ? parseProcStat(before.value) : undefined
    if (gcOwner === true) {
      const status = yield* procRead(fs.readFileString(`/proc/${pid}/status`))
      if (status._tag === 'gone') return { _tag: 'gone' } as const
      const uids = status._tag === 'value' ? parseProcUids(status.value) : undefined
      // Mixed/setuid identities are ours if any credential matches our UID.
      const foreign = uids !== undefined && uids.every((uid) => uid !== ownUid)
      const managerCandidate =
        parsed?.kernelThread === false &&
        parsed.parentPid === 1 &&
        before._tag === 'value' &&
        before.value.slice(before.value.indexOf('(') + 1, before.value.lastIndexOf(')')) ===
          'systemd' &&
        uids?.every((uid) => uid === ownUid) === true
      const cmdline =
        managerCandidate === true
          ? yield* procRead(fs.readFileString(`/proc/${pid}/cmdline`))
          : undefined
      const paths =
        parsed?.kernelThread === true
          ? { references: [], complete: true }
          : yield* readProcessReferencePaths({ fs, pid, retainPartial: true })
      const after = yield* procRead(fs.readFileString(`/proc/${pid}/stat`))
      if (after._tag === 'gone') return { _tag: 'gone' } as const
      const checked = after._tag === 'value' ? parseProcStat(after.value) : undefined
      const stable = parsed !== undefined && checked?.startTime === parsed.startTime
      const comm =
        before._tag === 'value'
          ? before.value.slice(before.value.indexOf('(') + 1, before.value.lastIndexOf(')'))
          : undefined
      const stableRole =
        stable &&
        parsed.kernelThread === false &&
        checked?.kernelThread === false &&
        checked.parentPid === parsed.parentPid &&
        after._tag === 'value' &&
        after.value.slice(after.value.indexOf('(') + 1, after.value.lastIndexOf(')')) === comm &&
        uids?.every((uid) => uid === ownUid) === true
      const systemdUserManager =
        stableRole &&
        managerCandidate &&
        cmdline?._tag === 'value' &&
        cmdline.value.split('\0')[1] === '--user'
      const allowed =
        stableRole === true ? GC_OWNER_EXEMPTIONS.find((entry) => entry.comm === comm) : undefined
      const sshParentVerified =
        allowed?.rule === 'sshd-privilege-transition' && parsed !== undefined
          ? yield* readSshPrivilegedParent({ fs, parentPid: parsed.parentPid })
          : false
      const exempt: ExemptProcess | undefined =
        paths.complete === false &&
        allowed !== undefined &&
        parsed !== undefined &&
        (allowed.rule !== 'systemd-user-manager' || systemdUserManager === true) &&
        (allowed.rule !== 'sshd-privilege-transition' || sshParentVerified === true)
          ? { pid, startTime: parsed.startTime, comm: allowed.comm, rule: allowed.rule }
          : undefined
      return {
        _tag: 'process',
        pid,
        parentPid: parsed?.parentPid ?? 0,
        references: paths.references,
        identity:
          stable === true && parsed.kernelThread === false
            ? { pid, startTime: parsed.startTime }
            : undefined,
        foreign,
        exempt,
        systemdUserManager,
        incomplete:
          parsed?.kernelThread === true
            ? stable === false
            : (paths.complete === false || stable === false || uids === undefined) &&
              !(stable && foreign === false && coveredStartTime === parsed.startTime),
      } as const
    }
    // Coverage cannot waive an unknown process lifetime.
    if (parsed === undefined) return { _tag: 'denied', pid } as const
    let references: ReadonlyArray<ProcessReference> | undefined = []
    let readReferences = parsed.kernelThread === false
    if (readReferences === true && ownUid !== undefined) {
      const status = yield* procRead(fs.readFileString(`/proc/${pid}/status`))
      const uids = status._tag === 'value' ? parseProcUids(status.value) : undefined
      if (uids === undefined) {
        references = undefined
        readReferences = false
      } else if (uids.some((uid) => uid !== ownUid) === true) {
        // Foreign identities (setuid included) stay in the ancestor table,
        // but their references are supplied by trusted all-UID evidence.
        readReferences = false
      }
    }
    // Covered processes are still read fully whenever their evidence is available.
    if (readReferences === true) {
      const paths = yield* readProcessReferencePaths({ fs, pid })
      references = paths.complete === true ? paths.references : undefined
    }
    const after = yield* procRead(fs.readFileString(`/proc/${pid}/stat`))
    if (after._tag === 'gone') return { _tag: 'gone' } as const
    const checked = after._tag === 'value' ? parseProcStat(after.value) : undefined
    if (checked === undefined || checked.startTime !== parsed.startTime) {
      return { _tag: 'denied', pid } as const
    }
    // Only an own-UID probe may rely on the exact lifetime a root snapshot read.
    // Its claims are merged by the caller; unavailable paths add no references.
    if (
      references === undefined &&
      (ownUid === undefined || coveredStartTime !== parsed.startTime)
    ) {
      return { _tag: 'denied', pid } as const
    }
    return {
      _tag: 'process',
      pid,
      parentPid: parsed.parentPid,
      references: references ?? [],
      identity: parsed.kernelThread === true ? undefined : { pid, startTime: parsed.startTime },
    } as const
  })

/** Which processes a reference scan must read completely. */
export type ProcessScanScope = 'all-uids' | 'own-uid' | 'gc-owner'

/**
 * One bounded lsof pass for all incomplete own-UID processes. No directory walk:
 * every file-name record (cwd, root, mapped files and descriptors) is retained.
 * Missing PID/cwd coverage, diagnostics and permission markers cannot prove free.
 */
const readLsofReferences = Effect.fn('store.readLsofReferences')(function* ({
  pids,
}: {
  pids: ReadonlyArray<number>
}) {
  const output = yield* readBoundedProcessOutput({
    binary: 'lsof',
    args: ['-n', '-P', '-a', '-p', pids.join(','), '-Fpfnt'],
  })
  const coveredPids = new Set<number>()
  if (output._tag === 'None') return { references: [], complete: false, coveredPids }
  const references: Array<ProcessReference> = []
  const requested = new Set(pids)
  let pid: number | undefined
  let file = ''
  let fileHasName = true
  let complete = output.value.exitCode === 0 && output.value.stderr.trim() === ''
  for (const line of output.value.stdout.split('\n')) {
    if (/permission denied|readlink:|can't stat|cannot stat|NOFD|unknown/i.test(line) === true) {
      complete = false
    }
    if (line.startsWith('p') === true) {
      if (fileHasName === false) complete = false
      const parsedPid = parsePidField(line.slice(1))
      pid = parsedPid !== undefined && requested.has(parsedPid) === true ? parsedPid : undefined
      if (pid === undefined) complete = false
      file = ''
      fileHasName = true
    }
    if (line.startsWith('f') === true) {
      if (fileHasName === false) complete = false
      file = line.slice(1)
      fileHasName = false
    }
    if (pid !== undefined && line.startsWith('n') === true) fileHasName = true
    if (pid !== undefined && line.startsWith('n/') === true) {
      if (file === 'cwd') coveredPids.add(pid)
      references.push({
        pid,
        kind: file === 'cwd' ? 'cwd' : file === 'rtd' ? 'root' : 'fd',
        path: withoutDeletedMarker(line.slice(1)),
      })
    }
  }
  return { references, complete: complete && fileHasName, coveredPids }
})

/**
 * Read Linux process cwd/root/fd/mapped-file references.
 *
 * Unlike the legacy cwd probe, an unreadable process is not skipped: another
 * owner's process may hold a worktree, so the scan becomes `unknown`. Only a
 * process that exits mid-scan is dropped, and kernel threads (which hold no
 * user files) are exempt. `own-uid` reads only processes whose every uid is
 * this process's uid; callers MUST pair it with trusted all-UID evidence for
 * the rest. An unreadable own-UID process may use `coveredProcesses` only when
 * its readable stat matches that root snapshot's lifetime before and after
 * the read. Available evidence is always read afresh. `selfPid` and its
 * descendants are excluded from references so megarepo's own git children
 * never veto its work; every scanned user-process identity is still returned.
 * `gc-owner` reads all available references, ignores and counts only incomplete
 * foreign-UID processes, and requires bounded lsof evidence for incomplete
 * own-UID processes except fixed verified systemd user-manager/PAM and SSH
 * privilege-transition roles. Readable references remain veto evidence.
 */
export const readProcessReferences = ({
  fs,
  selfPid,
  scope = 'all-uids',
  coveredProcesses,
}: {
  fs: FileSystem.FileSystem
  selfPid: number
  scope?: ProcessScanScope | undefined
  coveredProcesses?: ReadonlyArray<ProcessIdentity> | undefined
}): Effect.Effect<ProcessReferenceScan> =>
  Effect.gen(function* () {
    if (process.platform !== 'linux') return { _tag: 'unknown', reason: 'no-proc' } as const
    const ownUid = scope !== 'all-uids' ? process.getuid?.() : undefined
    if (scope !== 'all-uids' && ownUid === undefined) {
      return { _tag: 'unknown', reason: 'no-proc' } as const
    }
    const listing = yield* procRead(fs.readDirectory('/proc'))
    if (listing._tag !== 'value') return { _tag: 'unknown', reason: 'scan-failed' } as const
    const pids = listing.value.flatMap((entry) => {
      const pid = parsePidField(entry)
      return pid === undefined ? [] : [pid]
    })
    const spawner = yield* Effect.serviceOption(ChildProcessSpawner)
    const coverageByPid =
      scope !== 'all-uids'
        ? new Map(coveredProcesses?.map((identity) => [identity.pid, identity.startTime]))
        : undefined
    const entries = yield* Effect.forEach(
      pids,
      (pid) =>
        readProcessEntry({
          fs,
          pid,
          ownUid,
          coveredStartTime: coverageByPid?.get(pid),
          gcOwner: scope === 'gc-owner',
        }),
      { concurrency: 16 },
    )
    const processes: Array<Extract<ProcessEntry, { _tag: 'process' }>> = []
    for (const entry of entries) {
      if (entry._tag === 'denied') {
        return { _tag: 'unknown', reason: 'inaccessible-process', pid: entry.pid } as const
      }
      if (entry._tag === 'process') processes.push(entry)
    }
    const parentByPid = new Map(processes.map((entry) => [entry.pid, entry.parentPid]))
    // Only the root system manager's unit state can authenticate the mutable systemd name/argv.
    // Resolve once per scan, and bind its MainPID to the lifetime already observed above.
    let managerIdentity: ProcessIdentity | undefined
    if (
      scope === 'gc-owner' &&
      ownUid !== undefined &&
      spawner._tag === 'Some' &&
      processes.some((entry) => entry.systemdUserManager === true) === true
    ) {
      const systemctl = yield* fs
        .exists('/run/current-system/sw/bin/systemctl')
        .pipe(Effect.orElseSucceed(() => false))
      const output = yield* readBoundedProcessOutput({
        binary: systemctl === true ? '/run/current-system/sw/bin/systemctl' : '/usr/bin/systemctl',
        args: ['--system', 'show', `user@${ownUid}.service`, '--property=MainPID', '--value'],
        env: { DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/run/dbus/system_bus_socket', LC_ALL: 'C' },
      }).pipe(Effect.provideService(ChildProcessSpawner, spawner.value))
      if (output._tag === 'Some' && output.value.exitCode === 0) {
        const pid = parsePidField(output.value.stdout.trim())
        const observed = processes.find(
          (entry) => entry.pid === pid && entry.systemdUserManager === true,
        )
        if (pid !== undefined && observed?.identity !== undefined) {
          const current = yield* procRead(fs.readFileString(`/proc/${pid}/stat`))
          const parsed = current._tag === 'value' ? parseProcStat(current.value) : undefined
          if (parsed?.startTime === observed.identity.startTime) managerIdentity = observed.identity
        }
      }
    }
    const managerPids = new Set(managerIdentity === undefined ? [] : [managerIdentity.pid])
    const inScope = processes.filter(
      (entry) =>
        hasAncestorInTable({ parentByPid, pid: entry.pid, ancestorPid: selfPid }) === false,
    )
    for (const entry of inScope) {
      if (entry.exempt?.rule === 'systemd-user-manager' && managerPids.has(entry.pid) === false) {
        entry.exempt = undefined
      }
      if (entry.exempt?.rule === 'systemd-user-pam' && managerPids.has(entry.parentPid) === false) {
        entry.exempt = undefined
      }
    }
    const references = inScope.flatMap((entry) => entry.references)
    const metadata =
      scope === 'gc-owner'
        ? {
            ignoredForeignProcesses: inScope.filter(
              (entry) => entry.foreign === true && entry.incomplete === true,
            ).length,
            exemptProcesses: inScope.flatMap((entry) =>
              entry.exempt === undefined ? [] : [entry.exempt],
            ),
          }
        : {}
    if (scope === 'gc-owner') {
      let unreadablePid: number | undefined
      const fallbackPids = inScope
        .filter(
          (entry) =>
            entry.incomplete === true &&
            entry.foreign !== true &&
            entry.exempt === undefined &&
            entry.identity !== undefined,
        )
        .map((entry) => entry.pid)
      const fallback =
        spawner._tag === 'Some' && fallbackPids.length > 0
          ? yield* readLsofReferences({ pids: fallbackPids }).pipe(
              Effect.provideService(ChildProcessSpawner, spawner.value),
            )
          : { references: [], complete: false, coveredPids: new Set<number>() }
      references.push(...fallback.references)
      for (const entry of inScope) {
        if (entry.incomplete !== true || entry.foreign === true || entry.exempt !== undefined)
          continue
        if (spawner._tag === 'None' || entry.identity === undefined) {
          unreadablePid ??= entry.pid
          continue
        }
        const after = yield* procRead(fs.readFileString(`/proc/${entry.pid}/stat`))
        if (after._tag === 'gone') continue
        const checked = after._tag === 'value' ? parseProcStat(after.value) : undefined
        if (
          fallback.complete === false ||
          fallback.coveredPids.has(entry.pid) === false ||
          checked?.startTime !== entry.identity.startTime
        ) {
          unreadablePid ??= entry.pid
        }
      }
      if (unreadablePid !== undefined) {
        return {
          _tag: 'unknown',
          reason: 'own-uid-unreadable',
          pid: unreadablePid,
          references,
          ...metadata,
        } as const
      }
    }
    return {
      _tag: 'complete',
      references,
      ...metadata,
      processIdentities: processes.flatMap((entry) =>
        entry.identity === undefined ? [] : [entry.identity],
      ),
    } as const
  })

/**
 * Strict deletion-time probe: any process cwd, root, open file or mapped file
 * inside `worktreePath` holds it; any unreadable in-scope process or non-Linux
 * host is `unknown`. Callers MUST keep unless the result is `free`, and may
 * narrow `scope` to `own-uid` and supply `coveredProcesses` only under trusted
 * all-UID evidence whose claims are applied separately.
 */
export const readWorktreeReferencesInUse = ({
  worktreePath,
  selfPid = process.pid,
  scope = 'all-uids',
  coveredProcesses,
  ignoredProcesses,
}: {
  worktreePath: AbsoluteDirPath | string
  selfPid?: number | undefined
  scope?: ProcessScanScope | undefined
  coveredProcesses?: ReadonlyArray<ProcessIdentity> | undefined
  /** Only exact observed daemon/forkserver lifetimes may be checked separately via status. */
  ignoredProcesses?: ReadonlyArray<ProcessIdentity> | undefined
}): Effect.Effect<InUseResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const canonical = yield* procRead(fs.realPath(worktreePath))
    if (canonical._tag !== 'value') return { _tag: 'unknown', reason: 'scan-failed' } as const
    const scan = yield* readProcessReferences({ fs, selfPid, scope, coveredProcesses })
    const metadata =
      scan.ignoredForeignProcesses === undefined
        ? {}
        : {
            ignoredForeignProcesses: scan.ignoredForeignProcesses,
            exemptProcesses: scan.exemptProcesses,
          }
    const ignored = new Map(ignoredProcesses?.map((entry) => [entry.pid, entry.startTime]))
    const excluded = new Set(
      (scan._tag === 'complete' ? scan.processIdentities : [])
        .filter((entry) => ignored.get(entry.pid) === entry.startTime)
        .map((entry) => entry.pid),
    )
    const holder = (scan.references ?? []).find(
      (reference) =>
        excluded.has(reference.pid) === false &&
        isInsideWorktree({ candidate: reference.path, worktreePath: canonical.value }),
    )
    if (holder !== undefined) {
      return {
        _tag: 'in-use',
        holder: { pid: holder.pid, path: holder.path },
        ...metadata,
      } as const
    }
    return scan._tag === 'unknown'
      ? ({ _tag: 'unknown', reason: scan.reason, ...metadata } as const)
      : ({ _tag: 'free', ...metadata } as const)
  })
