import { lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'

// FileSystem.stat follows links; discovery must inspect the directory entry itself.
const readEntry = (path: string) => Effect.tryPromise(() => lstat(path)).pipe(Effect.option)

/** Discover canonical worktree roots without following descendant symlinks or entering archives/worktrees. */
export const discoverBuckMaintainWorktrees = Effect.fn('store.discoverBuckMaintainWorktrees')(
  function* (roots: ReadonlyArray<string>) {
    const fs = yield* FileSystem.FileSystem
    const found = new Set<string>()
    const seen = new Set<string>()
    const visit = ({
      path,
      root,
    }: {
      path: string
      root: string
    }): Effect.Effect<void, never, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const entry = yield* readEntry(path)
        if (Option.isNone(entry) === true || entry.value.isDirectory() === false) return
        const canonical = yield* fs.realPath(path).pipe(Effect.option)
        if (Option.isNone(canonical) === true) return
        const within = relative(root, canonical.value)
        if (
          within === '..' ||
          within.startsWith(`..${sep}`) === true ||
          isAbsolute(within) === true
        )
          return
        if (
          canonical.value.split(sep).includes('.archive') === true ||
          seen.has(canonical.value) === true
        )
          return
        seen.add(canonical.value)
        const git = yield* fs.stat(join(path, '.git')).pipe(
          Effect.map(() => 'present' as const),
          Effect.catchIf(
            (error) => error.reason._tag === 'NotFound',
            () => Effect.succeed('absent' as const),
          ),
          Effect.option,
        )
        if (Option.isNone(git) === true) return
        if (git.value === 'present') {
          const marker = yield* readEntry(join(path, '.git'))
          if (Option.isSome(marker) === true && marker.value.isSymbolicLink() === false)
            found.add(canonical.value)
          return
        }
        const children = yield* fs.readDirectory(path).pipe(Effect.option)
        if (Option.isNone(children) === true) return
        for (const child of children.value.toSorted()) {
          if (child.startsWith('.') === true) continue
          yield* visit({ path: join(path, child), root })
        }
      })
    for (const root of roots) {
      const canonical = yield* fs.realPath(root).pipe(Effect.option)
      if (Option.isSome(canonical) === true)
        yield* visit({ path: canonical.value, root: canonical.value })
    }
    return [...found].toSorted()
  },
)

const operationStates: Readonly<Record<string, true>> = {
  locked: true,
  MERGE_HEAD: true,
  'rebase-apply': true,
  'rebase-merge': true,
  REBASE_HEAD: true,
  CHERRY_PICK_HEAD: true,
  BISECT_LOG: true,
  BISECT_START: true,
  BISECT_NAMES: true,
  BISECT_EXPECTED_REV: true,
  REVERT_HEAD: true,
  sequencer: true,
}
const scanGitLocks: (args: {
  directory: string
  adminRoot: boolean
}) => Effect.Effect<boolean | undefined, never, FileSystem.FileSystem> = Effect.fn(
  'store.buckMaintain.scanGitLocks',
)(function* ({ directory, adminRoot }) {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs.readDirectory(directory).pipe(Effect.option)
  if (Option.isNone(entries) === true) return undefined
  let complete = true
  for (const name of entries.value) {
    if (
      name.endsWith('.lock') === true ||
      (adminRoot === true &&
        (operationStates[name] === true ||
          name.startsWith('BISECT') === true ||
          name.startsWith('REBASE') === true ||
          name.startsWith('CHERRY_PICK') === true))
    )
      return true
    const entry = yield* readEntry(join(directory, name))
    if (Option.isNone(entry) === true || entry.value.isSymbolicLink() === true) {
      complete = false
      continue
    }
    if (entry.value.isDirectory() === true) {
      const locked = yield* scanGitLocks({ directory: join(directory, name), adminRoot: false })
      if (locked === true) return true
      if (locked === undefined) complete = false
    }
  }
  return complete === true ? false : undefined
})

/** Read Git lock/operation vetoes and complete HEAD/index/reflog activity; uncertainty never proves idleness. */
export const readBuckMaintainGitEvidence = Effect.fn('store.buckMaintain.readGitEvidence')(
  function* (worktree: string) {
    const fs = yield* FileSystem.FileSystem
    const unknown = { locked: undefined, lastActivityMs: undefined }
    const marker = join(worktree, '.git')
    const markerInfo = yield* fs.stat(marker).pipe(Effect.option)
    if (Option.isNone(markerInfo) === true) return unknown
    let gitDir = marker
    if (markerInfo.value.type === 'File') {
      const content = yield* fs.readFileString(marker).pipe(Effect.option)
      if (Option.isNone(content) === true) return unknown
      const match = /^gitdir:\s*(.+)\s*$/u.exec(content.value.trim())
      if (match?.[1] === undefined) return unknown
      gitDir = resolve(worktree, match[1])
    } else if (markerInfo.value.type !== 'Directory') return unknown
    const info = yield* fs.stat(gitDir).pipe(Effect.option)
    if (Option.isNone(info) === true || info.value.type !== 'Directory') return unknown
    let locked = yield* scanGitLocks({ directory: gitDir, adminRoot: true })
    const common = yield* fs.readFileString(join(gitDir, 'commondir')).pipe(
      Effect.map((content) => ({ present: true as const, content })),
      Effect.catchIf(
        (error) => error.reason._tag === 'NotFound',
        () => Effect.succeed({ present: false as const, content: '' }),
      ),
      Effect.option,
    )
    if (Option.isNone(common) === true) {
      if (locked !== true) locked = undefined
    } else if (common.value.present === true) {
      const shared =
        common.value.content.trim().length === 0
          ? undefined
          : yield* scanGitLocks({
              directory: resolve(gitDir, common.value.content.trim()),
              adminRoot: false,
            })
      locked =
        locked === true || shared === true
          ? true
          : locked === undefined || shared === undefined
            ? undefined
            : false
    }
    let lastActivityMs: number | undefined
    let complete = true
    for (const name of ['HEAD', 'index', 'logs/HEAD']) {
      const path = join(gitDir, name)
      const readable = yield* fs
        .open(path, { flag: 'r' })
        .pipe(Effect.as(true), Effect.scoped, Effect.option)
      const stat = yield* fs.stat(path).pipe(Effect.option)
      const mtime =
        Option.isSome(stat) === true
          ? Option.getOrUndefined(stat.value.mtime)?.getTime()
          : undefined
      if (
        Option.isNone(readable) === true ||
        mtime === undefined ||
        Number.isFinite(mtime) === false
      )
        complete = false
      else lastActivityMs = Math.max(lastActivityMs ?? mtime, mtime)
    }
    return { locked, lastActivityMs: complete === true ? lastActivityMs : undefined }
  },
)

const readOutputTreeActivity: (
  directory: string,
) => Effect.Effect<number | undefined, never, FileSystem.FileSystem> = Effect.fn(
  'store.buckMaintain.readOutputTreeActivity',
)(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const entry = yield* readEntry(directory)
  if (Option.isNone(entry) === true || entry.value.isSymbolicLink() === true) return undefined
  const stat = yield* fs.stat(directory).pipe(Effect.option)
  const mtime =
    Option.isSome(stat) === true ? Option.getOrUndefined(stat.value.mtime)?.getTime() : undefined
  if (mtime === undefined || Number.isFinite(mtime) === false) return undefined
  if (entry.value.isDirectory() === false) return mtime
  const children = yield* fs.readDirectory(directory).pipe(Effect.option)
  if (Option.isNone(children) === true) return undefined
  let newest = mtime
  for (const child of children.value) {
    const activity = yield* readOutputTreeActivity(join(directory, child))
    if (activity === undefined) return undefined
    newest = Math.max(newest, activity)
  }
  return newest
})

/** Latest log and daemon-state activity across every isolation, including directory changes after daemon exit. */
export const readBuckMaintainOutputActivity = Effect.fn('store.buckMaintain.readOutputActivity')(
  function* (worktree: string) {
    const fs = yield* FileSystem.FileSystem
    const output = join(worktree, 'buck-out')
    const isolations = yield* fs.readDirectory(output).pipe(Effect.option)
    if (Option.isNone(isolations) === true || isolations.value.length === 0) return undefined
    let newest: number | undefined
    for (const isolation of isolations.value) {
      const directory = join(output, isolation)
      const entry = yield* readEntry(directory)
      if (Option.isNone(entry) === true || entry.value.isSymbolicLink() === true) return undefined
      if (entry.value.isDirectory() === false) continue
      for (const name of ['log', 'daemon']) {
        const path = join(directory, name)
        const info = yield* fs.stat(path).pipe(Effect.option)
        if (Option.isNone(info) === true || info.value.type !== 'Directory') return undefined
        const activity = yield* readOutputTreeActivity(path)
        if (activity === undefined) return undefined
        newest = Math.max(newest ?? activity, activity)
      }
    }
    return newest
  },
)
