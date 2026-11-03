import { constants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { Effect, Schema } from 'effect'

import * as Git from '../core/git.ts'
import { resolveGitCommonDir, withGitWriterLock } from './git-writer-lock.ts'

/** Refusal or failed metadata handover; never authorizes a weaker fallback. */
export class StoreRehomeError extends Schema.TaggedError<StoreRehomeError>()('StoreRehomeError', {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const git = (cwd: string) => (args: ReadonlyArray<string>) =>
  Git.runCommand({ cwd, args: ['--no-optional-locks', ...args] })
const io =
  (path: string) =>
  <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new StoreRehomeError({ path, message: 'Worktree rehome I/O failed', cause }),
    })

/** Compare physical Git identities; inaccessible or malformed repositories are errors. */
export const inspectForeignGitDir = Effect.fn('store.inspectForeignGitDir')(function* ({
  worktreePath,
  bareRepoPath,
}: {
  readonly worktreePath: string
  readonly bareRepoPath: string
}) {
  const canonical = yield* io(bareRepoPath)(() => realpath(bareRepoPath))
  const actual = yield* resolveGitCommonDir(worktreePath)
  return actual === canonical ? undefined : actual
})

/** Re-register a clean detached commit tree without checking out or deleting any tree files. */
export const rehomeCommitWorktree = Effect.fn('store.rehomeCommitWorktree')(function* ({
  worktreePath,
  bareRepoPath,
  dryRun = false,
}: {
  readonly worktreePath: string
  readonly bareRepoPath: string
  readonly dryRun?: boolean
}) {
  const tree = resolve(worktreePath)
  const bare = resolve(bareRepoPath)
  const control = join(tree, '.git')
  const sha = basename(tree)
  const refuse = (message: string) => new StoreRehomeError({ path: tree, message })
  const physicalDirectory = Effect.fn('store.rehomePhysicalDirectory')(function* (path: string) {
    if (
      (yield* io(path)(() => realpath(path))) !== path ||
      (yield* io(path)(() => lstat(path))).isDirectory() === false
    )
      return yield* refuse(`Expected a physical directory without symlink components: ${path}`)
  })
  const validate = Effect.fn('store.validateRehome')(function* () {
    if (
      /^[0-9a-f]{40}$/u.test(sha) === false ||
      tree !== join(dirname(bare), 'refs', 'commits', sha) ||
      basename(bare) !== '.bare'
    )
      return yield* refuse('Expected the exact canonical refs/commits/<40hex> path beside .bare')
    yield* physicalDirectory(tree)
    yield* physicalDirectory(bare)
    if ((yield* git(bare)(['rev-parse', '--is-bare-repository'])) !== 'true')
      return yield* refuse('Canonical .bare is not a bare repository')
    const info = yield* io(control)(() => lstat(control))
    if (info.isFile() === false || info.nlink !== 1 || info.uid !== process.getuid?.())
      return yield* refuse('Expected an owned regular, non-symlink .git control file with one link')
    if (
      (yield* git(tree)(['rev-parse', '--show-toplevel'])) !== tree ||
      (yield* git(tree)(['rev-parse', 'HEAD'])) !== sha ||
      (yield* git(tree)(['rev-parse', '--abbrev-ref', 'HEAD'])) !== 'HEAD'
    )
      return yield* refuse('Worktree root and detached HEAD must match the commit path')
    if (
      (yield* git(tree)([
        'status',
        '--porcelain',
        '--untracked-files=no',
        '--ignore-submodules=none',
      ])) !== ''
    )
      return yield* refuse('Tracked worktree or index changes prevent rehome')
    return {
      info,
      foreign: yield* inspectForeignGitDir({ worktreePath: tree, bareRepoPath: bare }),
    }
  })
  const observed = yield* validate()
  const plan = `Rehome ${tree} from ${observed.foreign ?? bare} to ${bare}; fetch missing ${sha} from the foreign repository, register a detached worktree, and preserve all worktree files and foreign registration`
  if (dryRun === true) return `Would ${plan.charAt(0).toLowerCase()}${plan.slice(1)}`
  return yield* Effect.gen(function* () {
    const { foreign } = yield* validate()
    if (foreign === undefined) {
      yield* git(bare)(['worktree', 'repair', tree])
      return `Already registered with ${bare}: ${tree}`
    }
    const present = yield* git(bare)(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).pipe(
      Effect.map(() => true),
      Effect.catchTag('GitCommandError', (error) =>
        error.exitCode === 1 ? Effect.succeed(false) : Effect.fail(error),
      ),
    )
    if (present === false)
      yield* git(bare)(['fetch', '--no-tags', '--no-write-fetch-head', '--', foreign, sha])
    const temporary = yield* io(tree)(() => mkdtemp(join(dirname(tree), '.mr-rehome-')))
    const prepared = join(temporary, 'tree')
    yield* git(bare)(['worktree', 'add', '--no-checkout', '--detach', '--', prepared, sha])
    yield* git(prepared)(['read-tree', sha])
    const admin = yield* git(prepared)(['rev-parse', '--absolute-git-dir'])
    if (dirname(admin) !== join(bare, 'worktrees'))
      return yield* refuse('New registration escaped canonical worktree administration')
    yield* physicalDirectory(admin)
    if ((yield* io(admin)(() => lstat(admin))).uid !== process.getuid?.())
      return yield* refuse('New administration directory is not owned by this user')
    const backup = join(temporary, 'original.git')
    // Unlike writeFileAtomic, control creation needs O_EXCL/O_NOFOLLOW. Both
    // replacements are sibling renames; no checkout ever touches the real tree.
    yield* Effect.gen(function* () {
      const { info, foreign: current } = yield* validate()
      if (current !== foreign) return yield* refuse('Git common directory changed during rehome')
      yield* io(control)(async () => {
        const original = await open(control, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const saved = await original.stat()
          if (saved.dev !== info.dev || saved.ino !== info.ino || saved.isFile() === false)
            throw refuse('Control file changed before backup')
          const copy = await open(
            backup,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          )
          try {
            await copy.writeFile(await original.readFile())
          } finally {
            await copy.close()
          }
        } finally {
          await original.close()
        }
      })
      const backlink = join(admin, 'gitdir')
      yield* io(backlink)(async () => {
        if ((await lstat(backlink)).isFile() === false) throw refuse('Unsafe admin backlink')
        const next = `${backlink}.mr-rehome`
        const file = await open(
          next,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
        try {
          await file.writeFile(`${control}\n`)
        } finally {
          await file.close()
        }
        await rename(next, backlink)
        const named = await lstat(control)
        if (named.dev !== info.dev || named.ino !== info.ino || named.isFile() === false)
          throw refuse('Control file changed before replacement')
        const replacement = await lstat(join(prepared, '.git'))
        if (replacement.isFile() === false || replacement.nlink !== 1)
          throw refuse('Unsafe prepared .git control file')
        await rename(join(prepared, '.git'), control)
      })
      yield* git(bare)(['worktree', 'repair', tree]).pipe(
        Effect.catchCause((cause) =>
          io(control)(() => rename(backup, control)).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      )
      yield* io(temporary)(async () => {
        await unlink(backup)
        await rmdir(prepared)
        await rmdir(temporary)
      })
    }).pipe(Effect.uninterruptible)
    return plan
  }).pipe(withGitWriterLock({ path: bare }))
})
