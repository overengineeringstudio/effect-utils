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
 * directory right now? Evidence is `/proc/<pid>/cwd` on Linux and `lsof`'s cwd
 * table on macOS. Conservative in both directions that matter: no supported
 * process table, or an unreadable scan, is `unknown`, and the caller keeps.
 */

import { Effect } from 'effect'
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
export type InUseResult =
  | { readonly _tag: 'free' }
  | { readonly _tag: 'in-use'; readonly holder: InUseHolder }
  | {
      readonly _tag: 'unknown'
      readonly reason: 'no-proc' | 'scan-failed' | 'inaccessible-process'
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

/** Read macOS process cwd and parent evidence from the system `lsof`. */
const readDarwinProcessCwds: Effect.Effect<
  ReadonlyArray<DarwinProcessCwd> | undefined,
  never,
  ChildProcessSpawner
> = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner
  const lines = yield* spawner
    .lines(ChildProcess.make('/usr/sbin/lsof', ['-n', '-P', '-w', '-d', 'cwd', '-FpnR']))
    .pipe(Effect.timeout('5 seconds'), Effect.option)
  if (lines._tag === 'None') return undefined
  const observed = parseLsofProcessCwds(lines.value)
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

/** Complete reference table, or why completeness cannot be proven. */
export type ProcessReferenceScan =
  | { readonly _tag: 'complete'; readonly references: ReadonlyArray<ProcessReference> }
  | {
      readonly _tag: 'unknown'
      readonly reason: 'no-proc' | 'scan-failed' | 'inaccessible-process'
      readonly pid?: number | undefined
    }

/** `PF_KTHREAD` in `/proc/<pid>/stat` flags: no user address space or files. */
const PF_KTHREAD = 0x0020_0000

/**
 * Parse the parent pid and kernel-thread flag from `/proc/<pid>/stat`.
 * `comm` may contain spaces and parentheses, so fields start after the last `)`.
 */
export const parseProcStat = (
  content: string,
): { readonly parentPid: number; readonly kernelThread: boolean } | undefined => {
  const close = content.lastIndexOf(')')
  if (close === -1) return undefined
  // After `)`: state(3) ppid(4) pgrp session tty_nr tpgid flags(9).
  const fields = content.slice(close + 1).trim().split(/\s+/)
  const parentPid = Number(fields[1])
  const flags = Number(fields[6])
  if (
    Number.isSafeInteger(parentPid) === false ||
    parentPid < 0 ||
    Number.isSafeInteger(flags) === false ||
    flags < 0
  ) {
    return undefined
  }
  return { parentPid, kernelThread: (flags & PF_KTHREAD) !== 0 }
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

const readProcessEntry = ({
  fs,
  pid,
  ownUid,
}: {
  fs: FileSystem.FileSystem
  pid: number
  ownUid: number | undefined
}): Effect.Effect<ProcessEntry> =>
  Effect.gen(function* () {
    const stat = yield* procRead(fs.readFileString(`/proc/${pid}/stat`))
    if (stat._tag === 'gone') return { _tag: 'gone' } as const
    const parsed = stat._tag === 'value' ? parseProcStat(stat.value) : undefined
    if (parsed === undefined) return { _tag: 'denied', pid } as const
    if (parsed.kernelThread === true) {
      return { _tag: 'process', pid, parentPid: parsed.parentPid, references: [] } as const
    }
    if (ownUid !== undefined) {
      const status = yield* procRead(fs.readFileString(`/proc/${pid}/status`))
      if (status._tag === 'gone') return { _tag: 'gone' } as const
      const uids = status._tag === 'value' ? parseProcUids(status.value) : undefined
      if (uids === undefined) return { _tag: 'denied', pid } as const
      // Any foreign identity (setuid included) is left to the trusted
      // all-UID evidence; it stays in the table for the descendant walk.
      if (uids.some((uid) => uid !== ownUid) === true) {
        return { _tag: 'process', pid, parentPid: parsed.parentPid, references: [] } as const
      }
    }
    const references: Array<ProcessReference> = []
    for (const kind of ['cwd', 'root'] as const) {
      const link = yield* procRead(fs.readLink(`/proc/${pid}/${kind}`))
      if (link._tag === 'denied') return { _tag: 'denied', pid } as const
      if (link._tag === 'value') {
        references.push({ pid, kind, path: withoutDeletedMarker(link.value) })
      }
    }
    const fds = yield* procRead(fs.readDirectory(`/proc/${pid}/fd`))
    if (fds._tag === 'denied') return { _tag: 'denied', pid } as const
    const fdLinks = yield* Effect.forEach(
      fds._tag === 'value' ? fds.value : [],
      (fd) => procRead(fs.readLink(`/proc/${pid}/fd/${fd}`)),
      { concurrency: 32 },
    )
    for (const link of fdLinks) {
      if (link._tag === 'denied') return { _tag: 'denied', pid } as const
      // Sockets, pipes and anonymous inodes are not filesystem paths.
      if (link._tag === 'value' && link.value.startsWith('/') === true) {
        references.push({ pid, kind: 'fd', path: withoutDeletedMarker(link.value) })
      }
    }
    const maps = yield* procRead(fs.readFileString(`/proc/${pid}/maps`))
    if (maps._tag === 'denied') return { _tag: 'denied', pid } as const
    if (maps._tag === 'value') {
      for (const path of new Set(parseProcMapsPaths(maps.value))) {
        references.push({ pid, kind: 'map', path })
      }
    }
    return { _tag: 'process', pid, parentPid: parsed.parentPid, references } as const
  })

/** Which processes a reference scan must read completely. */
export type ProcessScanScope = 'all-uids' | 'own-uid'

/**
 * Read Linux process cwd/root/fd/mapped-file references.
 *
 * Unlike the legacy cwd probe, an unreadable process is not skipped: another
 * owner's process may hold a worktree, so the scan becomes `unknown`. Only a
 * process that exits mid-scan is dropped, and kernel threads (which hold no
 * user files) are exempt. `own-uid` reads only processes whose every uid is
 * this process's uid; callers MUST pair it with trusted all-UID evidence for
 * the rest. `selfPid` and its descendants are excluded so megarepo's own git
 * children never veto its work.
 */
export const readProcessReferences = ({
  fs,
  selfPid,
  scope = 'all-uids',
}: {
  fs: FileSystem.FileSystem
  selfPid: number
  scope?: ProcessScanScope | undefined
}): Effect.Effect<ProcessReferenceScan> =>
  Effect.gen(function* () {
    if (process.platform !== 'linux') return { _tag: 'unknown', reason: 'no-proc' } as const
    const ownUid = scope === 'own-uid' ? process.getuid?.() : undefined
    if (scope === 'own-uid' && ownUid === undefined) {
      return { _tag: 'unknown', reason: 'no-proc' } as const
    }
    const listing = yield* procRead(fs.readDirectory('/proc'))
    if (listing._tag !== 'value') return { _tag: 'unknown', reason: 'scan-failed' } as const
    const pids = listing.value.flatMap((entry) => {
      const pid = parsePidField(entry)
      return pid === undefined ? [] : [pid]
    })
    const entries = yield* Effect.forEach(pids, (pid) => readProcessEntry({ fs, pid, ownUid }), {
      concurrency: 16,
    })
    const processes: Array<Extract<ProcessEntry, { _tag: 'process' }>> = []
    for (const entry of entries) {
      if (entry._tag === 'denied') {
        return { _tag: 'unknown', reason: 'inaccessible-process', pid: entry.pid } as const
      }
      if (entry._tag === 'process') processes.push(entry)
    }
    const parentByPid = new Map(processes.map((entry) => [entry.pid, entry.parentPid]))
    return {
      _tag: 'complete',
      references: processes.flatMap((entry) =>
        hasAncestorInTable({ parentByPid, pid: entry.pid, ancestorPid: selfPid }) === true
          ? []
          : entry.references,
      ),
    } as const
  })

/**
 * Strict deletion-time probe: any process cwd, root, open file or mapped file
 * inside `worktreePath` holds it; any unreadable in-scope process or non-Linux
 * host is `unknown`. Callers MUST keep unless the result is `free`, and may
 * narrow `scope` to `own-uid` only under trusted all-UID evidence.
 */
export const readWorktreeReferencesInUse = ({
  worktreePath,
  selfPid = process.pid,
  scope = 'all-uids',
}: {
  worktreePath: AbsoluteDirPath | string
  selfPid?: number | undefined
  scope?: ProcessScanScope | undefined
}): Effect.Effect<InUseResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const canonical = yield* procRead(fs.realPath(worktreePath))
    if (canonical._tag !== 'value') return { _tag: 'unknown', reason: 'scan-failed' } as const
    const scan = yield* readProcessReferences({ fs, selfPid, scope })
    if (scan._tag === 'unknown') return { _tag: 'unknown', reason: scan.reason } as const
    const holder = scan.references.find((reference) =>
      isInsideWorktree({ candidate: reference.path, worktreePath: canonical.value }),
    )
    return holder === undefined
      ? ({ _tag: 'free' } as const)
      : ({ _tag: 'in-use', holder: { pid: holder.pid, path: holder.path } } as const)
  })
