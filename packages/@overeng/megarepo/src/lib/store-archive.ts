/**
 * Archive + reap for cold named-branch worktrees (decisions 0004/0007).
 *
 * `.archive/` is the single recoverable holding area ("trash", decision 0007):
 * a cold, stale, lossless worktree is MOVED there (recoverable), and archives
 * past a retention TTL are later reaped (hard-deleted) to reclaim disk.
 *
 * Three operations live here, each a thin Effect over real git/fs so the
 * caller (`mr store gc`) can sequence them under `withWorktreeLock` with a fresh
 * live-set veto re-check:
 *
 * 1. {@link archiveWorktree} — `git worktree move` the worktree under
 *    `<repoRoot>/.archive/<branch>--<ISO(now)>`, then FREE the branch so
 *    `mr apply` can re-materialize it (invariant 4). The directory move
 *    preserves dirty + untracked work intact and fixes the absolute gitlink, so
 *    no `git worktree repair` is needed. A metadata line is appended to
 *    `<repoRoot>/.archive/README.md`.
 * 2. {@link scanArchives} — enumerate archive entries via `Git.listWorktrees`
 *    (git's own worktree registry already lists them — that is exactly why they
 *    are excluded from the live set), filtered to paths under `<repoRoot>/.archive/`,
 *    parsing `archivedAtMs` from the strict trailing `--<ISO8601>` segment.
 * 3. {@link reapArchive} — `git worktree remove --force` then ensure the dir is
 *    gone. The retention-TTL gate and under-lock veto re-check are the caller's
 *    responsibility (this is the mechanism, not the policy).
 *
 * `now` is an explicit epoch-ms parameter threaded from the CLI edge — the
 * archive directory name and README timestamp NEVER read the ambient wall clock
 * on this persistence path.
 */

import { CommandExecutor, FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect, Option } from 'effect'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from './git.ts'

/** Relative directory name of the per-repo archive holding area. */
export const ARCHIVE_DIR_NAME = '.archive'

/** File the archive metadata log is appended to, relative to `<repoRoot>/.archive/`. */
export const ARCHIVE_README_NAME = 'README.md'

/**
 * One archive entry discovered by {@link scanArchives}.
 *
 * `archivedAtMs` is parsed from the directory's trailing `--<ISO8601>` segment;
 * `branch` is everything before it (branch names contain `-`/`--`/`/`).
 */
export interface ArchiveEntry {
  /** Absolute path to the archived worktree directory. */
  readonly path: AbsoluteDirPath
  /** Branch name recovered from the directory name (segment before `--<ISO8601>`). */
  readonly branch: string
  /** Epoch-ms parsed from the trailing ISO8601 timestamp segment. */
  readonly archivedAtMs: number
}

/**
 * Strict, anchored parse of an archive entry's path RELATIVE to `.archive/`
 * into `{ branch, archivedAtMs }`.
 *
 * The archive dir name embeds the FULL branch (including any `/`), so the
 * `.archive/`-relative path is `<branch>--<ISO8601>` — e.g. `feature/x--<ISO>`
 * (a nested directory). ISO8601 is exactly `YYYY-MM-DDTHH:mm:ss.sssZ` (the form
 * `new Date(now).toISOString()` produces). The branch segment is greedy so the
 * LAST `--<ISO8601>` is taken as the timestamp even though branch names
 * legitimately contain `-`, `--`, and `/`. A name that does not end in a valid
 * ISO8601 instant (or whose timestamp does not round-trip) yields
 * `Option.none()` and is skipped rather than mis-reaped.
 */
export const parseArchiveDirName = (
  relativeName: string,
): Option.Option<{
  readonly branch: string
  readonly archivedAtMs: number
}> => {
  const match = relativeName.match(
    /^(?<branch>.+)--(?<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/u,
  )
  const branch = match?.groups?.branch
  const ts = match?.groups?.ts
  if (branch === undefined || ts === undefined || branch.length === 0) {
    return Option.none()
  }

  const archivedAtMs = Date.parse(ts)
  // Reject non-instants AND values that do not round-trip back to the same ISO
  // string (e.g. an out-of-range day that `Date.parse` would normalize).
  if (Number.isNaN(archivedAtMs) || new Date(archivedAtMs).toISOString() !== ts) {
    return Option.none()
  }

  return Option.some({ branch, archivedAtMs })
}

const archiveDirPath = (repoRoot: AbsoluteDirPath): AbsoluteDirPath =>
  EffectPath.ops.join(repoRoot, EffectPath.unsafe.relativeDir(`${ARCHIVE_DIR_NAME}/`))

/**
 * Archive a cold worktree: move it under `<repoRoot>/.archive/`, free its branch,
 * and record metadata.
 *
 * Order matters and each step is the mechanism for an invariant:
 * 1. `mkdir -p <repoRoot>/.archive` FIRST — `git worktree move` requires the
 *    destination's parent to exist.
 * 2. `git -C <bare> worktree move <src> <dest>` — preserves dirty + untracked
 *    work (it travels with the directory) and rewrites the gitlink to the new
 *    absolute path, so no `git worktree repair` is needed afterwards.
 * 3. FREE the branch via `git -C <bare> branch -D <branch>` so `mr apply` can
 *    re-materialize it; the commit stays reachable through the remote-tracking
 *    ref (guaranteed by the lossless floor's invariant 2a, checked upstream).
 * 4. Append `branch, ISO(now), commit, reason` to `<repoRoot>/.archive/README.md`.
 *
 * Returns the destination path so the caller can surface a recovery hint. Any
 * git/fs failure propagates so the caller can report keep+error and leave the
 * original worktree intact.
 */
export const archiveWorktree = (args: {
  /** The repo root in the store: `<store>/<host>/<owner>/<repo>/`. */
  readonly repoRoot: AbsoluteDirPath
  /** The bare repo path: `<repoRoot>/.bare/`. */
  readonly bareRepoPath: AbsoluteDirPath
  /** Source worktree directory to archive. */
  readonly worktreePath: AbsoluteDirPath
  /** The `refs/heads/*` branch name the worktree materializes. */
  readonly branch: string
  /** The worktree HEAD commit, recorded in the metadata log. */
  readonly commit: string
  /** Human-readable reason recorded in the metadata log (e.g. `merged`/`closed`). */
  readonly reason: string
  /** Epoch-ms decision time; drives the archive dir name + README timestamp. */
  readonly now: number
}): Effect.Effect<
  AbsoluteDirPath,
  Git.GitCommandError | PlatformError.PlatformError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const iso = new Date(args.now).toISOString()
    const archiveDir = archiveDirPath(args.repoRoot)
    const destPath = EffectPath.ops.join(
      archiveDir,
      EffectPath.unsafe.relativeDir(`${args.branch}--${iso}/`),
    )

    // (1) Destination PARENT must exist before `git worktree move` (the branch
    // embeds `/`, so the dest is nested, e.g. `.archive/feature/x--<ISO>`). The
    // dest is always under `.archive/`, so its parent is never `undefined`.
    const destParent = EffectPath.ops.parent(destPath) ?? archiveDir
    yield* fs.makeDirectory(destParent, { recursive: true })

    // (2) Move the worktree — dirty + untracked work travels intact, gitlink fixed.
    yield* Git.moveWorktree({
      repoPath: args.bareRepoPath,
      fromPath: args.worktreePath,
      toPath: destPath,
    })

    // (3) Free the branch so `mr apply` can re-materialize it (invariant 4).
    yield* Git.deleteBranch({ repoPath: args.bareRepoPath, branch: args.branch, force: true })

    // (4) Append a metadata line to the archive README.
    const readmePath = EffectPath.ops.join(
      archiveDir,
      EffectPath.unsafe.relativeFile(ARCHIVE_README_NAME),
    )
    const existing = yield* fs
      .readFileString(readmePath)
      .pipe(Effect.catchAll(() => Effect.succeed('')))
    const line = `${args.branch}\t${iso}\t${args.commit}\t${args.reason}\n`
    yield* fs.writeFileString(readmePath, existing + line)

    return destPath
  }).pipe(
    Effect.withSpan('megarepo/store/gc/archive-worktree', {
      attributes: { 'span.label': args.branch, branch: args.branch, reason: args.reason },
    }),
  )

/**
 * Enumerate the archive entries under `<repoRoot>/.archive/`.
 *
 * Uses `Git.listWorktrees(bare)` — git's worktree registry already enumerates
 * archives (that is precisely why they are excluded from the live set today) —
 * filtered to paths under `<repoRoot>/.archive/`, parsing each entry's
 * `archivedAtMs` from its strict trailing `--<ISO8601>` segment. Entries whose
 * base name does not parse are skipped (never mis-reaped).
 */
export const scanArchives = (args: {
  readonly repoRoot: AbsoluteDirPath
  readonly bareRepoPath: AbsoluteDirPath
}): Effect.Effect<
  ReadonlyArray<ArchiveEntry>,
  Git.GitCommandError | PlatformError.PlatformError,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const archiveDir = archiveDirPath(args.repoRoot)
    // Normalize to a trailing-slash prefix so a sibling like `.archive-old/` can
    // never match by string prefix.
    const archivePrefix = archiveDir

    const worktrees = yield* Git.listWorktrees(args.bareRepoPath)

    const entries: Array<ArchiveEntry> = []
    for (const worktree of worktrees) {
      // git reports worktree paths without a trailing slash; normalize so the
      // prefix test cannot match a sibling like `.archive-old/`.
      const normalized = EffectPath.unsafe.absoluteDir(
        worktree.path.endsWith('/') ? worktree.path : `${worktree.path}/`,
      )
      if (normalized.startsWith(archivePrefix) === false) continue

      // Parse the path RELATIVE to `.archive/` (NOT just the base name): the
      // branch embeds `/`, so the dir is nested (e.g. `.archive/feature/x--<ISO>`)
      // and the full `feature/x` must be recovered, trailing slash stripped.
      const relative = normalized.slice(archivePrefix.length).replace(/\/+$/u, '')
      const parsed = parseArchiveDirName(relative)
      if (Option.isNone(parsed)) continue

      entries.push({
        path: normalized,
        branch: parsed.value.branch,
        archivedAtMs: parsed.value.archivedAtMs,
      })
    }

    return entries
  }).pipe(
    Effect.withSpan('megarepo/store/gc/scan-archives', {
      attributes: { 'span.label': 'scan-archives', repoRoot: args.repoRoot },
    }),
  )

/**
 * Reap (hard-delete) one archived worktree.
 *
 * `git worktree remove --force` unregisters the worktree and removes its
 * directory; we then ensure the directory is gone (defensive — a move/partial
 * state could leave it behind). The retention-TTL gate and the under-lock
 * live-set veto re-check are the CALLER's responsibility; this is the reclaim
 * mechanism only.
 */
export const reapArchive = (args: {
  readonly bareRepoPath: AbsoluteDirPath
  readonly path: AbsoluteDirPath
}): Effect.Effect<
  void,
  Git.GitCommandError | PlatformError.PlatformError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    yield* Git.removeWorktree({
      repoPath: args.bareRepoPath,
      worktreePath: args.path,
      force: true,
    })

    // Ensure the directory is actually gone (idempotent; `remove --force`
    // normally deletes it, but a stale/partial state must not survive reap).
    const exists = yield* fs.exists(args.path)
    if (exists === true) {
      yield* fs.remove(args.path, { recursive: true, force: true })
    }
  }).pipe(
    Effect.withSpan('megarepo/store/gc/reap-archive', {
      attributes: { 'span.label': 'reap-archive', path: args.path },
    }),
  )
