import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'

import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { systemError, type PlatformError } from 'effect/PlatformError'

/**
 * Whether a physical root is an author workspace rather than the shared consumer cache.
 * Offline proof from Git metadata, never from the path suffix: the root is the top of a
 * worktree of `<repo>/.bare`, its HEAD is `refs/heads/<B>`, it sits at the canonical
 * `<repo>/refs/heads/<B>`, and `<B>` is not the store's default branch (the bare's HEAD,
 * set at clone time to the remote's default). Subdirectories, detached or mismatched
 * worktrees and unresolvable defaults are not authored.
 */
export const isAuthorBranchWorkspace = (
  root: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const repo = root.match(/^(.+?)\/refs\/heads\/.+$/)?.[1]
    if (repo === undefined) return false
    const fs = yield* FileSystem.FileSystem
    const read = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ''))
    const real = (file: string) =>
      fs.realPath(file).pipe(Effect.orElseSucceed((): string | undefined => undefined))
    const gitdirLink = (yield* read(path.join(root, '.git'))).match(/^gitdir: (.+)\n?$/)?.[1]
    if (gitdirLink === undefined) return false
    const gitdir = yield* real(path.resolve(root, gitdirLink))
    const bare = yield* real(path.join(repo, '.bare'))
    if (gitdir === undefined || bare === undefined) return false
    if (path.dirname(gitdir) !== path.join(bare, 'worktrees')) return false
    const branch = (yield* read(path.join(gitdir, 'HEAD'))).match(
      /^ref: refs\/heads\/(.+)\n?$/,
    )?.[1]
    if (branch === undefined || path.join(repo, 'refs', 'heads', branch) !== root) return false
    const defaultBranch = (yield* read(path.join(bare, 'HEAD'))).match(
      /^ref: refs\/heads\/(.+)\n?$/,
    )?.[1]
    return defaultBranch !== undefined && defaultBranch !== branch
  })

/** Preserve kernel path traversal: a symlink must be followed before a later `..`. */
const resolvePhysicalMutationPath = (
  target: string,
): Effect.Effect<string, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const absolute = path.isAbsolute(target) === true ? target : `${process.cwd()}/${target}`
    let current = path.parse(absolute).root
    for (const component of absolute.split(path.sep)) {
      if (component === '' || component === '.') continue
      if (component === '..') {
        current = path.dirname(current)
        continue
      }
      const candidate = path.join(current, component)
      const resolved = yield* fs.realPath(candidate).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === 'NotFound',
          () => Effect.void,
        ),
      )
      if (typeof resolved === 'string') {
        current = resolved
        continue
      }
      // A dangling symlink still determines where a later mkdir/write will go.
      const link = yield* fs.readLink(candidate).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === 'NotFound',
          () => Effect.void,
        ),
      )
      current =
        typeof link !== 'string'
          ? candidate
          : yield* resolvePhysicalMutationPath(
              path.isAbsolute(link) === true ? link : `${current}/${link}`,
            )
    }
    return current
  })

/**
 * Create store namespace components with a stable mode, independent of umask.
 * Resolve aliases first, then use exclusive, non-recursive mkdir calls so only
 * directories created by this invocation are chmodded (including under races).
 */
export const makeStoreDirectory = Effect.fn('megarepo/store/make-directory')(function* (
  target: string,
) {
  const fs = yield* FileSystem.FileSystem
  const physical = yield* resolvePhysicalMutationPath(target)
  let current = path.parse(physical).root
  for (const component of physical.slice(current.length).split(path.sep)) {
    if (component === '') continue
    current = path.join(current, component)
    const created = yield* fs.makeDirectory(current, { mode: 0o755 }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === 'AlreadyExists',
        () => Effect.succeed(false),
      ),
    )
    if (
      created === true &&
      (process.platform === 'win32' ||
        typeof constants.O_DIRECTORY !== 'number' ||
        typeof constants.O_NOFOLLOW !== 'number')
    ) {
      return yield* systemError({
        _tag: 'PermissionDenied',
        module: 'megarepo',
        method: 'makeStoreDirectory',
        pathOrDescriptor: current,
        description: 'No-follow directory permission updates are unsupported on this platform',
      })
    }
    const isDirectory = yield* Effect.tryPromise({
      try: async () => {
        if ((await lstat(current)).isDirectory() === false) return false
        if (created === true) {
          // Pin the inode: chmod must never follow a symlink substituted after mkdir.
          const directory = await open(
            current,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          )
          try {
            await directory.chmod(0o755)
          } finally {
            await directory.close()
          }
        }
        return true
      },
      catch: (cause) =>
        systemError({
          _tag: 'Unknown',
          module: 'megarepo',
          method: 'makeStoreDirectory',
          pathOrDescriptor: current,
          description: 'Cannot inspect or set the mode of a physical store directory',
          cause,
        }),
    })
    if (isDirectory === false) {
      return yield* systemError({
        _tag: 'PermissionDenied',
        module: 'megarepo',
        method: 'makeStoreDirectory',
        pathOrDescriptor: current,
        description: 'Store namespace component must be a physical directory',
      })
    }
  }
})

/** Ref worktrees are shared. Resolve aliases and missing output parents before authorizing writes. */
export const assertCanonicalMutationAllowed = ({
  target,
  materializationRoot,
  materializedRoot,
  commitApplyRoot,
  authoringRoot,
}: {
  target: string
  materializationRoot?: string
  /** Physical identity of a commit worktree freshly created by this apply invocation. */
  materializedRoot?: string
  /** Exact physical commit root whose Git root and HEAD top-level apply proved, with lock sync off. */
  commitApplyRoot?: string
  /** Invoking author workspace for file writes; aliases must remain inside its physical root. */
  authoringRoot?: string
}): Effect.Effect<string, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const resolvedPath = yield* resolvePhysicalMutationPath(target)
    if (process.env['MEGAREPO_ALLOW_CANONICAL_MUTATION'] === '1') return resolvedPath
    const physicalAuthoringRoot =
      authoringRoot === undefined ? undefined : yield* resolvePhysicalMutationPath(authoringRoot)
    if (
      materializedRoot !== undefined ||
      commitApplyRoot !== undefined ||
      (physicalAuthoringRoot !== undefined &&
        /\/refs\/(?:commits|heads|tags)\/.+/.test(physicalAuthoringRoot) === true) ||
      /\/refs\/(?:commits|heads|tags)\/.+/.test(resolvedPath) === true
    ) {
      if (authoringRoot !== undefined && physicalAuthoringRoot !== undefined) {
        const workspacePath = path.resolve(authoringRoot)
        const targetPath = path.resolve(target)
        const destination = resolvedPath
        if (
          (targetPath === workspacePath ||
            targetPath.startsWith(`${workspacePath}${path.sep}`) === true) &&
          (destination === physicalAuthoringRoot ||
            destination.startsWith(`${physicalAuthoringRoot}${path.sep}`) === true) &&
          (yield* isAuthorBranchWorkspace(physicalAuthoringRoot)) === true
        ) {
          return resolvedPath
        }
      }
      const commitRoot = materializedRoot ?? commitApplyRoot
      if (commitRoot !== undefined) {
        const root = path.resolve(commitRoot)
        const workspacePath = path.resolve(materializationRoot ?? commitRoot)
        const targetPath = path.resolve(target)
        const destination = resolvedPath
        if (
          /\/refs\/commits\/[^/]+$/.test(root) === true &&
          ((targetPath === workspacePath && destination === root) ||
            (targetPath === path.join(workspacePath, 'repos') &&
              destination === path.join(root, 'repos')))
        ) {
          return resolvedPath
        }
      }
      // Top-level apply/fetch owns an invoking non-default branch workspace's mount directory.
      // Fresh recursive materialization never authorizes authoring outputs.
      if (materializationRoot !== undefined && materializedRoot === undefined) {
        const root = yield* resolvePhysicalMutationPath(materializationRoot)
        const destination = resolvedPath
        const targetPath = path.resolve(target)
        const workspacePath = path.resolve(materializationRoot)
        if (
          root.match(/\/refs\/(commits|heads|tags)\/.+/)?.[1] === 'heads' &&
          ((targetPath === workspacePath && destination === root) ||
            (targetPath === path.join(workspacePath, 'repos') &&
              destination === path.join(root, 'repos'))) &&
          (yield* isAuthorBranchWorkspace(root)) === true
        ) {
          return resolvedPath
        }
      }
      return yield* systemError({
        _tag: 'PermissionDenied',
        module: 'megarepo',
        method: 'authorizeMutation',
        pathOrDescriptor: resolvedPath,
        description:
          `Refusing to mutate canonical worktree '${resolvedPath}'. ` +
          (authoringRoot !== undefined
            ? 'Authoring writes require an owned author workspace and must stay inside it; shared canonical caches remain protected. '
            : materializationRoot !== undefined
              ? 'Member mount preparation is not allowed in this shared canonical cache. Prepare it from the owning workspace, or use an owned worktree. '
              : 'Lock and other protected authoring writes require an owned worktree; disabling lock sync does not authorize these writes. ') +
          'Explicit administrative override: MEGAREPO_ALLOW_CANONICAL_MUTATION=1.',
      })
    }
    return resolvedPath
  })

/** Return the authorized physical path; all mkdir/write operations must use this path. */
export const authorizeAuthorWorkspaceWrite = ({
  target,
  workspaceRoot,
}: {
  target: string
  workspaceRoot: string
}): Effect.Effect<string, PlatformError, FileSystem.FileSystem> =>
  assertCanonicalMutationAllowed({ target, authoringRoot: workspaceRoot })

/**
 * Abbreviate a megarepo store path to owner/repo@ref format.
 *
 * Store paths follow: `~/.megarepo/github.com/<owner>/<repo>/refs/(heads|tags|commits)/<ref>`
 * Output: `<owner>/<repo>@<ref>`
 *
 * Falls back to the last path segment if the pattern doesn't match.
 */
export const abbreviateStorePath = (storePath: string): string => {
  // Try to match the full store path pattern
  const match = storePath.match(
    /github\.com\/([^/]+)\/([^/]+)\/refs\/(?:heads|tags|commits)\/(.+?)(?:\/)?$/,
  )
  if (match !== null) {
    return `${match[1]}/${match[2]}@${match[3]}`
  }

  // Fallback: last non-empty path segment
  const segments = storePath.replace(/\/+$/, '').split('/')
  const last = segments[segments.length - 1]
  return last !== undefined && last !== '' ? last : storePath
}
