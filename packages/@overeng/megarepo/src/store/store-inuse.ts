/**
 * In-use guard for store worktrees.
 *
 * The cold-GC liveness signal (`store-liveness.ts` / `classifyStoreWorktreePolicy`)
 * answers "is this worktree referenced by some workspace's reconciled manifest?".
 * That is NOT the same as "is a live OS process currently working inside it":
 * a freshly-created or repinned-but-unregistered worktree can be absent from
 * every manifest while a coding-agent session sits in it with its cwd there.
 *
 * Archiving such a worktree is a directory rename, and on Linux a rename is
 * transparent to a process already in that directory — its cwd silently follows
 * the inode into `.archive/`, and the subsequent `git` bookkeeping (detach +
 * branch free, then a `mr apply` re-checkout) breaks the session mid-flight.
 * This module is the orthogonal, strictly stronger guard: before any destructive
 * archive/reap, refuse if a live process has the worktree (or a descendant) as
 * its cwd (or, optionally, an open file handle).
 *
 * Two seams, mirroring `store-gc-observations.ts` (pure `nextObservationLedger`
 * vs effectful IO):
 * - {@link classifyInUse} — PURE: given the worktree path, the already-read
 *   `{ pid, path }` list, and the pids to exclude, return the FIRST matching
 *   holder (`Option`) so the caller can attribute the veto. Unit-tested.
 * - {@link readWorktreeInUse} — the effectful Linux `/proc` reader that produces
 *   that list and computes the exclude set (current process + its descendants),
 *   then calls the pure classifier under an OTel span.
 *
 * Conservative direction (in doubt → KEEP): on a host without `/proc` (e.g.
 * macOS) the reader returns `{ _tag: 'unknown' }`, which the caller MUST treat
 * as in-use (do not archive). Per-pid permission/race errors (`EACCES`/`ESRCH`)
 * skip that pid; they never fail the whole check.
 */

import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import type { AbsoluteDirPath } from '@overeng/effect-path'

import * as Observability from '../core/observability.ts'

/** One process's path of interest (its cwd, or an open file/fd target). */
export interface ProcPath {
  /** The owning process id. */
  readonly pid: number
  /** An absolute path the process holds (cwd or an open file), as read from `/proc`. */
  readonly path: string
}

/** A live process found holding the worktree (or a descendant) — the veto's attribution. */
export interface InUseHolder {
  /** The pid working inside the worktree. */
  readonly pid: number
  /** The held path (cwd or open file) that falls under the worktree. */
  readonly path: string
}

/**
 * Result of the in-use probe.
 *
 * - `in-use` — a live, non-excluded process holds the worktree; carries the
 *   first {@link InUseHolder} for attribution.
 * - `free` — no live process holds it (safe to archive, w.r.t. this guard).
 * - `unknown` — the probe could not run (no `/proc` on this host); the caller
 *   MUST treat this conservatively as KEEP.
 */
export type InUseResult =
  | { readonly _tag: 'in-use'; readonly holder: InUseHolder }
  | { readonly _tag: 'free' }
  | { readonly _tag: 'unknown'; readonly reason: string }

const stripTrailingSlashes = (path: string): string => path.replace(/\/+$/u, '')

/**
 * True if `candidate` is the worktree itself or strictly nested under it.
 *
 * Both sides are normalized to a no-trailing-slash form, then the test is
 * `candidate === wt || candidate.startsWith(wt + '/')`. The explicit `+ '/'`
 * boundary is what keeps a sibling like `<wt>.archive-old` (or `<wt>-2`) from
 * matching by raw string prefix.
 */
export const isPathInsideWorktree = ({
  worktreePath,
  candidate,
}: {
  readonly worktreePath: string
  readonly candidate: string
}): boolean => {
  const wt = stripTrailingSlashes(worktreePath)
  const cand = stripTrailingSlashes(candidate)
  return cand === wt || cand.startsWith(`${wt}/`)
}

/**
 * Pure in-use classifier (the unit-tested seam).
 *
 * Returns the FIRST `{ pid, path }` whose `path` is the worktree or a descendant
 * and whose `pid` is not in `excludePids`. `excludePids` is supplied by the
 * caller (the IO layer computes "current process + its descendants") so this
 * stays pure AND so a test can drive it with an explicit exclude set — the IO
 * reader must NOT bake the exclusion in, or an integration test's holder process
 * (itself a descendant of the test runner) would be silently excluded.
 */
export const classifyInUse = ({
  worktreePath,
  procPaths,
  excludePids,
}: {
  readonly worktreePath: string
  readonly procPaths: ReadonlyArray<ProcPath>
  readonly excludePids: ReadonlySet<number>
}): Option.Option<InUseHolder> => {
  for (const { pid, path } of procPaths) {
    if (excludePids.has(pid) === true) continue
    if (isPathInsideWorktree({ worktreePath, candidate: path }) === true) {
      return Option.some({ pid, path })
    }
  }
  return Option.none()
}

const PROC_ROOT = '/proc'

/** Parse a `/proc` directory entry name into a numeric pid (non-numeric ⇒ none). */
const parsePid = (name: string): Option.Option<number> => {
  if (/^\d+$/u.test(name) === false) return Option.none()
  const pid = Number.parseInt(name, 10)
  return Number.isInteger(pid) === true && pid > 0 ? Option.some(pid) : Option.none()
}

/**
 * Read one `/proc/<pid>` process's paths of interest.
 *
 * Always reads `cwd` (the load-bearing signal that matches the incident: a cwd
 * that follows the archive rename). When `scanOpenFiles` is set, also reads the
 * `fd/*` symlink targets so a process with an open file handle inside the
 * worktree (but cwd elsewhere) is still caught. Every read is tolerant: a
 * vanished/permission-denied pid yields no paths rather than failing.
 */
const readProcPaths = ({
  pid,
  scanOpenFiles,
}: {
  readonly pid: number
  readonly scanOpenFiles: boolean
}): Effect.Effect<ReadonlyArray<ProcPath>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths: Array<ProcPath> = []

    const cwd = yield* fs.readLink(`${PROC_ROOT}/${pid}/cwd`).pipe(Effect.orElseSucceed(() => null))
    if (cwd !== null) paths.push({ pid, path: cwd })

    if (scanOpenFiles === true) {
      const fdDir = `${PROC_ROOT}/${pid}/fd`
      const fds = yield* fs
        .readDirectory(fdDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
      for (const fd of fds) {
        const target = yield* fs.readLink(`${fdDir}/${fd}`).pipe(Effect.orElseSucceed(() => null))
        // Only absolute filesystem paths matter; `/proc` fd links can point at
        // sockets/pipes (`socket:[…]`) etc., which never fall under a worktree.
        if (target !== null && target.startsWith('/') === true) paths.push({ pid, path: target })
      }
    }

    return paths
  })

/** Read `PPid:` from `/proc/<pid>/status` (the only field we need for the chain walk). */
const readPpid = ({
  pid,
}: {
  readonly pid: number
}): Effect.Effect<Option.Option<number>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = yield* fs
      .readFileString(`${PROC_ROOT}/${pid}/status`)
      .pipe(Effect.orElseSucceed(() => null))
    if (content === null) return Option.none()
    const match = content.match(/^PPid:\s*(\d+)$/mu)
    if (match?.[1] === undefined) return Option.none()
    const ppid = Number.parseInt(match[1], 10)
    return Number.isInteger(ppid) === true ? Option.some(ppid) : Option.none()
  })

/**
 * Decide whether `pid` is the current process or one of its descendants.
 *
 * Walks the PPid chain UPWARD from `pid`: hit `selfPid` ⇒ exclude (it is us or
 * our child); hit pid 0/1 or an unreadable link ⇒ keep (an unrelated process).
 * Walking up from a single matched pid is far cheaper than materializing the
 * whole process tree, and the walk only runs for the rare in-worktree matches.
 * A `seen` set guards against a pathological cycle.
 */
const isSelfOrDescendant = ({
  pid,
  selfPid,
}: {
  readonly pid: number
  readonly selfPid: number
}): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const seen = new Set<number>()
    let current = pid
    while (current > 1 && seen.has(current) === false) {
      if (current === selfPid) return true
      seen.add(current)
      const ppid = yield* readPpid({ pid: current })
      if (Option.isNone(ppid) === true) return false
      current = ppid.value
    }
    return current === selfPid
  })

/**
 * Effectful in-use probe for one worktree (the IO seam).
 *
 * On Linux: enumerate `/proc`, read each pid's cwd (and optionally open files),
 * run the pure {@link classifyInUse} with an EMPTY exclude set to find any
 * candidate holder, then — only if a candidate exists — exclude the current
 * process and its descendants via a PPid-chain walk so the gc process itself
 * (and the git children it may have spawned with a cwd inside the worktree)
 * never self-veto. The first surviving holder ⇒ `in-use`.
 *
 * On a host without `/proc` ⇒ `{ _tag: 'unknown' }` (caller treats as KEEP).
 *
 * `selfPid` defaults to `process.pid`; it is injectable so a test can pin it.
 */
export const readWorktreeInUse = ({
  worktreePath,
  scanOpenFiles = false,
  selfPid = process.pid,
}: {
  readonly worktreePath: AbsoluteDirPath
  readonly scanOpenFiles?: boolean
  readonly selfPid?: number
}): Effect.Effect<InUseResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const procExists = yield* fs.exists(PROC_ROOT).pipe(Effect.orElseSucceed(() => false))
    if (procExists === false) {
      return { _tag: 'unknown' as const, reason: 'no /proc on this host' }
    }

    const entries = yield* fs
      .readDirectory(PROC_ROOT)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    const pids = entries.flatMap((name) => Option.getOrElse(parsePid(name), () => [] as never))

    // Read all candidate paths. Self-exclusion is NOT applied here (it is the
    // classifier's `excludePids`), so the read stays a pure enumeration.
    const procPaths: Array<ProcPath> = []
    for (const pid of pids) {
      const paths = yield* readProcPaths({ pid, scanOpenFiles })
      for (const p of paths) procPaths.push(p)
    }

    // Find the first in-worktree candidate ignoring nobody, then walk only that
    // (and any subsequent) candidate's ancestry to drop self+descendants. This
    // keeps the expensive PPid walk off the common no-match path.
    const excludePids = new Set<number>()
    for (;;) {
      const candidate = classifyInUse({ worktreePath, procPaths, excludePids })
      if (Option.isNone(candidate) === true) break
      const holder = candidate.value
      const excluded = yield* isSelfOrDescendant({ pid: holder.pid, selfPid })
      if (excluded === false) {
        return { _tag: 'in-use' as const, holder }
      }
      excludePids.add(holder.pid)
    }

    return { _tag: 'free' as const }
  }).pipe(Observability.withInUseProbeSpan(worktreePath))
